// 세션에 답하기(승인·선택지·글). 웹(POST /api/sessions/:id/reply)과 텔레그램(버튼·답장)이 같은 처리를 쓴다.
import { randomUUID } from 'node:crypto';
import { REPLY_STALE_SECONDS, type ReplyAnswer, type ReplyRequest, type SessionStatus } from '@c-monitor/shared';
import { publishSessions } from '../query/views';
import type { Deps } from '../types';
import { tryDeliver } from './deliver';
import { machineCanReply, statusCanReply } from './pending';

/**
 * ok              답을 넣었다(queued=true 면 글이 아직 전달 전)
 * not_found       그 사용자의 세션이 아님(관리자도 남의 것은 not_found)
 * reply_disabled  컴퓨터의 원격 답장이 꺼졌거나 플러그인이 낮음, 또는 종료·끊김 세션
 * no_pending      그 승인·질문은 이미 끝났다(터미널에서 먼저 답함 등)
 * invalid_body    요청 종류에 맞지 않는 답(질문에 허용, 쓸 수 없는 "이 세션 동안 허용" 등)
 */
export type SubmitResult =
  | { ok: true; queued: boolean }
  | { ok: false; error: 'not_found' | 'reply_disabled' | 'no_pending' | 'invalid_body' };

export async function submitReply(
  deps: Pick<Deps, 'sql' | 'bus' | 'now' | 'reply'>, userId: string, sessionId: string, body: ReplyRequest,
): Promise<SubmitResult> {
  const { sql } = deps;
  const [s] = await sql<{
    user_id: string; status: SessionStatus; remote_reply: boolean; plugin_version: string; revoked_at: Date | null;
  }[]>`
    SELECT s.user_id, s.status, m.remote_reply, m.plugin_version, m.revoked_at
    FROM sessions s JOIN machines m ON m.id = s.machine_id WHERE s.id = ${sessionId}`;
  if (!s || s.user_id !== userId) return { ok: false, error: 'not_found' };
  const machineOk = machineCanReply({ remoteReply: s.remote_reply, revoked: s.revoked_at !== null, pluginVersion: s.plugin_version });
  if (!machineOk || !statusCanReply(s.status)) return { ok: false, error: 'reply_disabled' };

  const now = deps.now();

  if (body.type === 'message') {
    await sql`
      INSERT INTO session_messages (id, session_id, machine_id, user_id, text, created_at)
      SELECT ${randomUUID()}, id, machine_id, user_id, ${body.text}, ${now} FROM sessions WHERE id = ${sessionId}`;
    // 세션이 done이고 대기자가 붙어 있으면 바로 넘어간다. 아니면 쌓아 둔다.
    const delivered = await tryDeliver(deps, sessionId);
    if (!delivered) await publishSessions(deps, [sessionId]);
    return { ok: true, queued: !delivered };
  }

  const requestId = body.requestId;
  const answer: ReplyAnswer = body.type === 'answer'
    ? { type: 'answer', answers: body.answers }
    : { type: 'permission', behavior: body.behavior, ...(body.message ? { message: body.message } : {}) };

  const outcome = await sql.begin(async (tx): Promise<'ok' | 'no_pending' | 'stale' | 'invalid'> => {
    // 행을 잠가 같은 요청에 답이 두 번 들어가지 않게 한다(첫 번째만 적용).
    const [r] = await tx<{ kind: 'permission' | 'question'; session_allow: string | null; polled_at: Date }[]>`
      SELECT kind, session_allow, polled_at FROM reply_requests
      WHERE id = ${requestId} AND session_id = ${sessionId} AND status = 'pending' FOR UPDATE`;
    if (!r) return 'no_pending';
    // 플러그인이 오래 다시 묻지 않았으면 답을 받을 훅이 이미 없다.
    if (now.getTime() - r.polled_at.getTime() > REPLY_STALE_SECONDS * 1000) {
      await tx`UPDATE reply_requests SET status = 'gone' WHERE id = ${requestId}`;
      return 'stale';
    }
    // 요청 종류에 맞는 답만 받는다: 질문에는 answer 또는 거부, 승인에는 permission.
    // "이 세션 동안 허용"은 플러그인이 그 선택을 줬을 때만.
    const fits = answer.type === 'answer'
      ? r.kind === 'question'
      : r.kind === 'question'
        ? answer.behavior === 'deny'
        : answer.behavior !== 'allow_session' || r.session_allow !== null;
    if (!fits) return 'invalid';
    await tx`
      UPDATE reply_requests SET status = 'answered', answer = ${tx.json(answer as never)}, answered_at = ${now}
      WHERE id = ${requestId}`;
    // 더 기다리는 요청이 없으면 세션은 다시 일하는 중이다(뒤따르는 이벤트를 기다리지 않고 바로 반영).
    await tx`
      UPDATE sessions SET status = 'run', last_event_at = GREATEST(last_event_at, ${now})
      WHERE id = ${sessionId} AND status = 'wait'
        AND NOT EXISTS (SELECT 1 FROM reply_requests WHERE session_id = ${sessionId} AND status = 'pending')`;
    return 'ok';
  });

  if (outcome === 'invalid') return { ok: false, error: 'invalid_body' };
  if (outcome === 'no_pending') return { ok: false, error: 'no_pending' };
  deps.reply.notifyRequests([requestId]);
  await publishSessions(deps, [sessionId]);
  if (outcome === 'stale') return { ok: false, error: 'no_pending' };
  return { ok: true, queued: false };
}
