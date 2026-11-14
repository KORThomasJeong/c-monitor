// 원격 답장(2차). 계약: shared/src/contract.ts "원격 답장(2차)".
//   기기 토큰  POST /api/reply/ask · /api/reply/wait · /api/reply/inbox
//   로그인     POST /api/sessions/:id/reply · PATCH /api/machines/:id
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { ZodType, ZodTypeDef } from 'zod';
import {
  MAX_BATCH_BYTES, MachinePatchSchema, REPLY_POLL_SECONDS,
  ReplyAskSchema, ReplyInboxSchema, ReplyRequestSchema, ReplyWaitSchema,
  type ReplyAnswer, type ReplyAskResponse, type ReplyInboxResponse, type ReplyResponse, type ReplyWaitResponse,
  type SessionStatus,
} from '@c-monitor/shared';
import { machineGuard, requireMachine, requireUser, userGuard } from '../auth/guard';
import { loadMachineViews, publishSessions } from '../query/views';
import type { Deps, Env } from '../types';
import { fail, parseJsonBody, readLimitedText } from '../util';
import { notifyRequest } from '../notify/notify';
import { submitReply } from './answer';
import { tryDeliver } from './deliver';
import { statusCanReply } from './pending';

/** 스위치를 바꿀 때 다시 내보내는 세션 수의 상한. */
const MACHINE_SESSION_LIMIT = 500;

type RequestState = { status: 'pending' | 'answered' | 'gone'; answer: ReplyAnswer | null };

const waitResponse = (r: RequestState): ReplyWaitResponse =>
  r.status === 'answered' && r.answer ? { status: 'answered', answer: r.answer }
    : r.status === 'pending' ? { status: 'pending' } : { status: 'gone' };

export function replyRoutes(deps: Deps): Hono<Env> {
  const { sql } = deps;
  const hub = deps.reply;
  const app = new Hono<Env>();
  const active = userGuard(deps, 'active');
  const machine = machineGuard(deps);
  const pollMs = () => deps.replyPollMs ?? REPLY_POLL_SECONDS * 1000;

  /** 본문을 크기 제한 안에서 읽어 스키마로 검사한다. */
  async function readLimited<T>(req: Request, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
    const text = await readLimitedText(req, MAX_BATCH_BYTES);
    if (text === null) throw fail(413, 'too_large');
    const parsed = schema.safeParse(parseJsonBody(text));
    if (!parsed.success) throw fail(400, 'invalid_body');
    return parsed.data;
  }

  /**
   * 무언가 일어나거나(wake), 붙잡는 시간이 다 되거나, 클라이언트가 연결을 끊을 때까지 기다린다.
   * → 연결이 끊겨서 끝났으면 'aborted'.
   */
  function hold(signal: AbortSignal, wake: Promise<unknown>): Promise<'woke' | 'timeout' | 'aborted'> {
    return new Promise((resolve) => {
      const finish = (why: 'woke' | 'timeout' | 'aborted') => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(why);
      };
      const onAbort = () => finish('aborted');
      const timer = setTimeout(() => finish('timeout'), pollMs());
      if (signal.aborted) return finish('aborted');
      signal.addEventListener('abort', onAbort);
      void wake.then(() => finish('woke'));
    });
  }

  // ── 기기 토큰 경로 ───────────────────────────────────────

  // 승인·질문 등록(규칙 1). 세션을 wait·안 봄으로 만들어 바로 내보낸다.
  app.post('/api/reply/ask', machine, async (c) => {
    const m = requireMachine(c);
    const body = await readLimited(c.req.raw, ReplyAskSchema);
    if (body.kind === 'question' && !body.questions) throw fail(400, 'invalid_body');
    if (!m.remoteReply) return c.json<ReplyAskResponse>({ disabled: true });

    const now = deps.now();
    const requestId = randomUUID();
    const sessionId = `${m.id}:${body.sessionId}`;
    const touched = await sql.begin(async (tx) => {
      await tx`
        INSERT INTO reply_requests (id, session_id, machine_id, user_id, kind, tool_name, tool_input, questions,
                                    session_allow, agent_id, created_at, polled_at)
        VALUES (${requestId}, ${sessionId}, ${m.id}, ${m.userId}, ${body.kind}, ${body.toolName},
                ${tx.json((body.toolInput ?? null) as never)},
                ${body.kind === 'question' ? tx.json(body.questions as never) : null},
                ${body.sessionAllow}, ${body.agentId}, ${body.at}, ${now})`;
      // 세션 행이 아직 없으면 요청만 저장된다 — 뒤에 오는 이벤트가 세션을 만들 때 wait로 맞춘다(ingest/apply.ts).
      return tx`
        UPDATE sessions SET status = 'wait', seen = false, last_event_at = GREATEST(last_event_at, ${now})
        WHERE id = ${sessionId} AND status <> 'end' RETURNING id`;
    });
    if (touched.length > 0) await publishSessions(deps, [sessionId]);
    // 텔레그램 알림(비동기 — 이 요청을 기다리게 하지 않는다).
    notifyRequest(deps, requestId);
    return c.json<ReplyAskResponse>({ requestId });
  });

  // 답 기다리기(규칙 2). 부를 때마다 polled_at을 갱신한다. 없는 요청·남의 기기 요청은 404.
  app.post('/api/reply/wait', machine, async (c) => {
    const m = requireMachine(c);
    const { requestId } = await readLimited(c.req.raw, ReplyWaitSchema);
    /** 아직 기다리는 요청이면 "방금 물어봄"을 적고, 지금 상태를 읽는다. */
    const poll = async (): Promise<RequestState | undefined> => (await sql<RequestState[]>`
      UPDATE reply_requests SET polled_at = CASE WHEN status = 'pending' THEN ${deps.now()} ELSE polled_at END
      WHERE id = ${requestId} AND machine_id = ${m.id} RETURNING status, answer`)[0];

    // 읽는 사이에 온 답을 놓치지 않도록 먼저 대기자로 등록한다.
    const waiter = hub.waitRequest(requestId);
    try {
      let row = await poll();
      if (!row) throw fail(404, 'not_found');
      if (row.status === 'pending') {
        const why = await hold(c.req.raw.signal, waiter.promise);
        // 연결이 끊겼으면 답을 받을 곳이 없다 — polled_at도 건드리지 않고 끝낸다.
        if (why !== 'aborted') row = (await poll()) ?? { status: 'gone', answer: null };
      }
      return c.json<ReplyWaitResponse>(waitResponse(row));
    } finally {
      waiter.cancel();
    }
  });

  // 글 기다리기(규칙 4). 세션마다 대기자는 하나 — 새 대기자가 붙으면 옛 대기자는 gone.
  app.post('/api/reply/inbox', machine, async (c) => {
    const m = requireMachine(c);
    const body = await readLimited(c.req.raw, ReplyInboxSchema);
    if (!m.remoteReply) return c.json<ReplyInboxResponse>({ status: 'gone' });

    const sessionId = `${m.id}:${body.sessionId}`;
    // 종료·끊김 세션에는 글을 보낼 수 없으니 기다릴 것도 없다.
    // 세션 행이 아직 없으면(SessionStart의 inbox가 수집보다 먼저 올 수 있다) 그냥 붙잡아 둔다.
    const [s] = await sql<{ status: SessionStatus }[]>`SELECT status FROM sessions WHERE id = ${sessionId}`;
    if (s && !statusCanReply(s.status)) return c.json<ReplyInboxResponse>({ status: 'gone' });
    const waiter = hub.attachInbox(sessionId, m.id, body.waiterId);
    // 이미 쌓인 글이 있고 세션이 done이면 바로 넘어온다.
    tryDeliver(deps, sessionId).catch((err) => console.error('[reply] 글 전달 실패:', err));
    const why = await hold(c.req.raw.signal, waiter.promise);
    // 시간이 다 됐거나 연결이 끊겼으면 대기자를 정리한다(이미 결과가 정해졌으면 아무 일도 없다).
    if (why !== 'woke') waiter.resolve({ status: 'pending' });
    return c.json<ReplyInboxResponse>(await waiter.promise);
  });

  // ── 로그인 경로 ─────────────────────────────────────────

  // 웹에서 답 보내기. 세션 소유자 본인만(관리자도 남의 것은 404).
  app.post('/api/sessions/:id/reply', active, async (c) => {
    const user = requireUser(c);
    const id = c.req.param('id');
    const body = await readLimited(c.req.raw, ReplyRequestSchema);

    const result = await submitReply(deps, user.id, id, body);
    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : result.error === 'invalid_body' ? 400 : 409;
      throw fail(status, result.error);
    }
    return c.json<ReplyResponse>({ ok: true, queued: result.queued });
  });

  // 컴퓨터별 원격 답장 스위치. 소유자만.
  app.patch('/api/machines/:id', active, async (c) => {
    const user = requireUser(c);
    const machineId = c.req.param('id');
    const { remoteReply } = await readLimited(c.req.raw, MachinePatchSchema);
    const rows = await sql`
      UPDATE machines SET remote_reply = ${remoteReply}
      WHERE id = ${machineId} AND user_id = ${user.id} AND revoked_at IS NULL RETURNING id`;
    if (rows.length === 0) throw fail(404, 'not_found');

    if (!remoteReply) {
      // 끄면 기다리던 승인·질문은 gone, 아직 전달하지 않은 글은 버린다(나중에 켰을 때 옛 글이 튀어나오지 않게).
      const gone = await sql<{ id: string }[]>`
        UPDATE reply_requests SET status = 'gone' WHERE machine_id = ${machineId} AND status = 'pending' RETURNING id`;
      await sql`DELETE FROM session_messages WHERE machine_id = ${machineId} AND delivered_at IS NULL`;
      hub.notifyRequests(gone.map((r) => r.id));
      hub.dropInbox({ machineId });
    }

    const [view] = await loadMachineViews(sql, user.id, deps.now(), { id: machineId });
    deps.bus.publish(user.id, { type: 'machine', machine: view! });
    // 그 컴퓨터 세션들의 canReply·pending이 달라지므로 함께 다시 내보낸다.
    const sessions = await sql<{ id: string }[]>`
      SELECT id FROM sessions WHERE machine_id = ${machineId} AND status <> 'end'
      ORDER BY last_event_at DESC LIMIT ${MACHINE_SESSION_LIMIT}`;
    await publishSessions(deps, sessions.map((r) => r.id));
    return c.json(view);
  });

  return app;
}
