// 원격 답장(2차): 승인·질문 등록과 답, 글 보내기, 컴퓨터별 스위치, 정리.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MESSAGE_MAX_CHARS, REPLY_STALE_SECONDS,
  type DashboardSnapshot, type HookEvent, type IngestBatch, type MachineView, type ReplyAsk, type SessionView, type StreamMessage,
} from '@c-monitor/shared';
import { runCleanup } from '../src/jobs/cleanup';
import { summaryOf, versionAtLeast } from '../src/reply/pending';
import { sweepStaleRequests } from '../src/reply/sweep';
import { ADMIN, DAY, makeHarness, makeTestDb, sseReader, type TestDb } from './helpers';

let db: TestDb;
/** 붙잡는 시간이 넉넉한 서버 — 답·글이 오면 바로 풀리는지 본다. */
let h: ReturnType<typeof makeHarness>;
/** 붙잡는 시간이 아주 짧은 서버(같은 DB) — 시간이 다 되면 pending으로 끝나는지 본다. */
let quick: ReturnType<typeof makeHarness>;
let admin: string;
let a: { cookie: string; id: string; token: string; machineId: string };
let b: { cookie: string; id: string; token: string; machineId: string };

/** 원격 답장을 지원하는 플러그인 버전의 기기 정보. */
const MACHINE = { name: 'pc-a', os: 'win32', pluginVersion: '0.2.0' };

beforeAll(async () => {
  db = await makeTestDb();
  h = makeHarness(db, { replyPollMs: 15_000 });
  quick = makeHarness(db, { replyPollMs: 60, now: () => h.deps.now() });
  admin = await h.login(ADMIN);
  const ua = await h.activeUser('a@example.com');
  const ub = await h.activeUser('b@example.com');
  a = { ...ua, ...(await h.connect(ua.cookie, 'pc-a')) };
  b = { ...ub, ...(await h.connect(ub.cookie, 'pc-b')) };
  await send([]);
  await h.ingest(b.token, { ...h.batch([]), machine: { ...MACHINE, name: 'pc-b' } });
});
afterAll(async () => { await db.drop(); });

const sid = (name: string) => `${a.machineId}:${name}`;
const send = (events: HookEvent[], extra: Partial<IngestBatch> = {}) =>
  h.ingest(a.token, { ...h.batch(events, extra), machine: MACHINE });

/** 작업 중(run)인 세션을 만든다. */
async function running(name: string): Promise<void> {
  expect((await send([h.ev(name, 'UserPromptSubmit', { prompt: '시작' })])).status).toBe(200);
}

function askBody(name: string, over: Partial<ReplyAsk> = {}): ReplyAsk {
  return {
    sessionId: name, kind: 'permission', toolName: 'Bash', toolInput: { command: 'npm test', description: '테스트 실행' },
    agentId: null, sessionAllow: null, at: h.clock.now.toISOString(), ...over,
  };
}
async function ask(name: string, over: Partial<ReplyAsk> = {}, token = a.token): Promise<string> {
  const res = await h.req('POST', '/api/reply/ask', { token, body: askBody(name, over) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { requestId: string }).requestId;
}
const wait = (requestId: string, token = a.token, on = h) => on.req('POST', '/api/reply/wait', { token, body: { requestId } });
const inbox = (name: string, waiterId: string = randomUUID(), token = a.token, on = h) =>
  on.req('POST', '/api/reply/inbox', { token, body: { sessionId: name, waiterId } });
const reply = (name: string, body: unknown, cookie = a.cookie) =>
  h.req('POST', `/api/sessions/${encodeURIComponent(sid(name))}/reply`, { cookie, body });

async function view(name: string, cookie = a.cookie, q = ''): Promise<SessionView> {
  const snap = (await (await h.req('GET', `/api/sessions${q}`, { cookie })).json()) as DashboardSnapshot;
  const s = snap.sessions.find((x) => x.id === sid(name));
  if (!s) throw new Error(`세션 없음: ${name}`);
  return s;
}

/** 조건이 참이 될 때까지 잠깐씩 기다린다(대기자가 붙는 순간을 맞추기 위해). */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error('조건을 기다리다 시간이 다 됐습니다');
}
const sessionMsgs = (name: string) =>
  h.published.filter((p) => p.msg.type === 'session' && p.msg.session.id === sid(name))
    .map((p) => (p.msg as Extract<StreamMessage, { type: 'session' }>).session);

describe('승인 요청', () => {
  it('등록하면 세션이 wait·안 봄이 되고 pending이 실려 나가며, 웹에서 허용하면 wait가 답을 받는다', async () => {
    await running('p1');
    h.published.length = 0;
    const requestId = await ask('p1', { sessionAllow: '이 세션 동안 npm 명령을 허용' });

    const s = await view('p1');
    expect(s).toMatchObject({ status: 'wait', seen: false, canReply: true, queuedMessages: 0, remoteUrl: null });
    expect(s.pending).toEqual({
      id: requestId, kind: 'permission', toolName: 'Bash', summary: 'npm test',
      sessionAllow: '이 세션 동안 npm 명령을 허용', at: h.clock.now.toISOString(), more: 0,
    });
    // 등록하자마자 소유자에게 session이 나간다
    expect(h.published.map((p) => p.userId)).toEqual([a.id]);
    expect(sessionMsgs('p1')[0]!.pending!.id).toBe(requestId);

    const held = wait(requestId);
    await until(() => h.deps.reply.size().requests === 1);
    h.published.length = 0;
    const res = await reply('p1', { type: 'permission', requestId, behavior: 'allow' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, queued: false });
    expect(await (await held).json()).toEqual({ status: 'answered', answer: { type: 'permission', behavior: 'allow' } });
    expect(h.deps.reply.size().requests).toBe(0);

    // 답한 뒤에는 pending이 사라지고 다시 작업 중으로 보인다
    expect(await view('p1')).toMatchObject({ status: 'run', pending: null });
    expect(sessionMsgs('p1').at(-1)).toMatchObject({ status: 'run', pending: null });
    // 답이 난 요청을 다시 물어도 같은 답을 바로 받는다
    expect(await (await wait(requestId)).json()).toEqual({ status: 'answered', answer: { type: 'permission', behavior: 'allow' } });
  });

  it('"이 세션 동안 허용"은 플러그인이 그 선택을 준 요청에만 쓸 수 있다', async () => {
    await running('p2');
    const withAllow = await ask('p2', { sessionAllow: '편집 자동 허용 모드로 전환' });
    const res = await reply('p2', { type: 'permission', requestId: withAllow, behavior: 'allow_session' });
    expect(res.status).toBe(200);
    expect(await (await wait(withAllow)).json()).toEqual({ status: 'answered', answer: { type: 'permission', behavior: 'allow_session' } });

    const without = await ask('p2');
    expect((await reply('p2', { type: 'permission', requestId: without, behavior: 'allow_session' })).status).toBe(400);
    expect((await view('p2')).pending!.id).toBe(without); // 잘못된 답은 요청을 건드리지 않는다
  });

  it('거부하면 사유와 함께 전달된다', async () => {
    await running('p3');
    const requestId = await ask('p3');
    expect((await reply('p3', { type: 'permission', requestId, behavior: 'deny', message: '그 명령 말고 lint만 돌려 주세요' })).status).toBe(200);
    expect(await (await wait(requestId)).json()).toEqual({
      status: 'answered', answer: { type: 'permission', behavior: 'deny', message: '그 명령 말고 lint만 돌려 주세요' },
    });
  });

  it('여러 요청이 함께 기다리면 가장 오래된 것을 보여 주고 more로 나머지 수를 알린다', async () => {
    await running('p4');
    const first = await ask('p4', { toolInput: { file_path: '/work/a.ts' }, toolName: 'Edit' });
    h.advance(1000);
    await ask('p4', { toolInput: { command: 'ls' }, agentId: 'agent-1' });
    expect((await view('p4')).pending).toMatchObject({ id: first, toolName: 'Edit', summary: '/work/a.ts', more: 1 });

    // 하나에 답해도 다른 요청이 남아 있으면 계속 wait
    expect((await reply('p4', { type: 'permission', requestId: first, behavior: 'allow' })).status).toBe(200);
    expect(await view('p4')).toMatchObject({ status: 'wait', pending: { toolName: 'Bash', summary: 'ls', more: 0 } });
  });

  it('세션 행이 아직 없으면 요청만 저장하고, 세션이 생기면 wait로 보인다', async () => {
    h.published.length = 0;
    const requestId = await ask('p5');
    expect(h.published).toEqual([]);
    expect((await db.sql`SELECT 1 FROM sessions WHERE id = ${sid('p5')}`).length).toBe(0);

    // 등록보다 늦게 도착한 PreToolUse(같은 시각) — 요청을 치우지 않고, 세션은 wait·안 봄
    await send([h.ev('p5', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } })]);
    expect(await view('p5')).toMatchObject({ status: 'wait', seen: false, pending: { id: requestId } });
  });

  it('요약은 명령·경로 등에서 처음 있는 것을 300자까지, 없으면 질문 글', () => {
    expect(summaryOf({ description: '설명', command: '명령' }, null)).toBe('명령');
    expect(summaryOf({ url: 'https://example.com/x' }, null)).toBe('https://example.com/x');
    expect(summaryOf({ command: '가'.repeat(500) }, null)).toHaveLength(300);
    expect(summaryOf({ questions: [] }, [{ question: '어느 쪽으로 할까요?', options: [] }])).toBe('어느 쪽으로 할까요?');
    expect(summaryOf(null, null)).toBe('');
  });
});

describe('선택지 질문', () => {
  const questions = [
    { question: '어떤 DB를 쓸까요?', header: 'DB', options: [{ label: 'Postgres', description: '기본' }, { label: 'SQLite' }] },
    { question: '테스트도 만들까요?', multiSelect: false, options: [{ label: '예' }, { label: '아니오' }] },
  ];

  it('질문을 보여 주고, 웹의 답이 wait로 전달된다', async () => {
    await running('q1');
    const requestId = await ask('q1', { kind: 'question', toolName: 'AskUserQuestion', toolInput: { questions }, questions });
    expect((await view('q1')).pending).toMatchObject({
      id: requestId, kind: 'question', toolName: 'AskUserQuestion', summary: '어떤 DB를 쓸까요?', questions,
    });

    const held = wait(requestId);
    const answers = { '어떤 DB를 쓸까요?': 'Postgres', '테스트도 만들까요?': '직접 쓴 답' };
    // 질문에 "허용"은 맞지 않는 답이다
    expect((await reply('q1', { type: 'permission', requestId, behavior: 'allow' })).status).toBe(400);
    expect((await reply('q1', { type: 'answer', requestId, answers })).status).toBe(200);
    expect(await (await held).json()).toEqual({ status: 'answered', answer: { type: 'answer', answers } });
  });

  it('질문은 거부할 수 있고, 승인 요청에 answer를 보내면 400', async () => {
    await running('q2');
    const q = await ask('q2', { kind: 'question', toolName: 'AskUserQuestion', toolInput: { questions }, questions });
    expect((await reply('q2', { type: 'permission', requestId: q, behavior: 'deny', message: '지금은 답하지 않겠습니다' })).status).toBe(200);
    const p = await ask('q2');
    expect((await reply('q2', { type: 'answer', requestId: p, answers: { x: 'y' } })).status).toBe(400);
  });

  it('질문 없이 kind=question으로 등록하면 400', async () => {
    const res = await h.req('POST', '/api/reply/ask', { token: a.token, body: askBody('q3', { kind: 'question' }) });
    expect(res.status).toBe(400);
    expect((await h.req('POST', '/api/reply/ask', { token: a.token, body: { sessionId: 'q3' } })).status).toBe(400);
    expect((await h.req('POST', '/api/reply/ask', { body: askBody('q3') })).status).toBe(401);
  });
});

describe('터미널에서 먼저 답함', () => {
  it('뒤따른 PostToolUse가 오면 gone이 되고, 웹에서 누르면 409 no_pending', async () => {
    await running('t1');
    const requestId = await ask('t1');
    const held = wait(requestId);
    await until(() => h.deps.reply.size().requests === 1);

    h.advance(2000);
    h.published.length = 0;
    await send([h.ev('t1', 'PostToolUse', { tool_name: 'Bash' })]);
    expect(await (await held).json()).toEqual({ status: 'gone' });
    expect(await view('t1')).toMatchObject({ status: 'run', pending: null });
    expect(sessionMsgs('t1').at(-1)).toMatchObject({ pending: null });

    const before = await db.sql`SELECT status, seen, last_event_at FROM sessions WHERE id = ${sid('t1')}`;
    const res = await reply('t1', { type: 'permission', requestId, behavior: 'allow' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'no_pending' });
    // 세션에는 아무 영향이 없다
    expect(await db.sql`SELECT status, seen, last_event_at FROM sessions WHERE id = ${sid('t1')}`).toEqual(before);
    expect(await (await wait(requestId)).json()).toEqual({ status: 'gone' });
  });

  it('PreToolUse·요청보다 앞선 이벤트·다른 에이전트의 이벤트로는 치우지 않는다', async () => {
    await running('t2');
    const early = h.ev('t2', 'PostToolUse', { tool_name: 'Read' }); // 요청보다 먼저 생긴 이벤트(늦게 도착)
    h.advance(1000);
    const requestId = await ask('t2', { agentId: 'agent-7' });
    h.advance(1000);

    await send([
      early,
      h.ev('t2', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, agent_id: 'agent-7' }),
      h.ev('t2', 'PostToolUse', { tool_name: 'Grep' }), // 메인 세션의 것
      h.ev('t2', 'PostToolUse', { tool_name: 'Grep', agent_id: 'agent-8' }),
    ]);
    expect(await view('t2')).toMatchObject({ status: 'wait', pending: { id: requestId } });

    // 같은 에이전트의 뒤따른 이벤트면 치운다
    await send([h.ev('t2', 'PostToolUseFailure', { tool_name: 'Bash', agent_id: 'agent-7' })]);
    expect((await view('t2')).pending).toBeNull();
  });

  it('UserPromptSubmit·Stop·StopFailure로도 치우고, SessionEnd는 에이전트를 가리지 않고 모두 치운다', async () => {
    for (const [name, event] of [['t3', 'UserPromptSubmit'], ['t4', 'Stop'], ['t5', 'StopFailure']] as const) {
      await running(name);
      await ask(name);
      h.advance(1000);
      await send([h.ev(name, event, {})]);
      expect([name, (await view(name)).pending]).toEqual([name, null]);
    }
    await running('t6');
    const main = await ask('t6');
    const sub = await ask('t6', { agentId: 'agent-1' });
    h.advance(1000);
    await send([h.ev('t6', 'SessionEnd', { reason: 'exit' })]);
    const rows = await db.sql<{ id: string; status: string }[]>`SELECT id, status FROM reply_requests WHERE id IN ${db.sql([main, sub])}`;
    expect(rows.map((r) => r.status)).toEqual(['gone', 'gone']);
  });
});

describe('같은 요청에 답이 두 번', () => {
  it('첫 번째만 적용되고 두 번째는 409 no_pending', async () => {
    await running('d1');
    const requestId = await ask('d1');
    expect((await reply('d1', { type: 'permission', requestId, behavior: 'deny', message: '첫 답' })).status).toBe(200);
    const second = await reply('d1', { type: 'permission', requestId, behavior: 'allow' });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'no_pending' });
    expect(await (await wait(requestId)).json()).toEqual({
      status: 'answered', answer: { type: 'permission', behavior: 'deny', message: '첫 답' },
    });
  });

  it('동시에 두 번 눌러도 하나만 성공한다', async () => {
    await running('d2');
    const requestId = await ask('d2');
    const results = await Promise.all([
      reply('d2', { type: 'permission', requestId, behavior: 'allow' }),
      reply('d2', { type: 'permission', requestId, behavior: 'deny' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

describe('남의 세션', () => {
  it('다른 사용자·관리자의 로그인으로는 답하거나 글을 넣을 수 없다(404)', async () => {
    await running('o1');
    const requestId = await ask('o1');
    for (const cookie of [b.cookie, admin]) {
      for (const body of [
        { type: 'permission', requestId, behavior: 'allow' },
        { type: 'message', text: '남이 넣는 글' },
      ]) {
        const res = await reply('o1', body, cookie);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'not_found' });
      }
    }
    expect((await h.req('POST', `/api/sessions/${encodeURIComponent(sid('o1'))}/reply`, {
      body: { type: 'permission', requestId, behavior: 'allow' },
    })).status).toBe(401);
    expect((await h.req('POST', '/api/sessions/none/reply', { cookie: a.cookie, body: { type: 'message', text: 'x' } })).status).toBe(404);
    expect((await view('o1')).pending!.id).toBe(requestId);
    expect((await db.sql`SELECT 1 FROM session_messages WHERE session_id = ${sid('o1')}`).length).toBe(0);
  });

  it('다른 기기 토큰으로는 요청을 기다리거나 볼 수 없다(404), 같은 세션 이름으로 등록해도 섞이지 않는다', async () => {
    const requestId = (await view('o1')).pending!.id;
    const res = await wait(requestId, b.token);
    expect(res.status).toBe(404);
    expect((await wait('없는-요청')).status).toBe(404);
    expect((await h.req('POST', '/api/reply/wait', { body: { requestId } })).status).toBe(401);

    h.published.length = 0;
    const mine = await ask('o1', { toolInput: { command: 'B의 명령' } }, b.token);
    expect(h.published).toEqual([]); // B에게는 그 이름의 세션이 없다 — A의 세션은 건드리지 않는다
    expect((await view('o1')).pending).toMatchObject({ id: requestId, more: 0 });
    expect((await wait(mine, a.token)).status).toBe(404);
  });

  it('관리자가 남의 대시보드를 볼 때는 pending을 비우고 canReply=false', async () => {
    const s = await view('o1', admin, `?user=${a.id}`);
    expect(s).toMatchObject({ status: 'wait', pending: null, canReply: false, queuedMessages: 0 });
  });
});

describe('컴퓨터별 스위치 (PATCH /api/machines/:id)', () => {
  const patch = (remoteReply: unknown, cookie = a.cookie, id = a.machineId) =>
    h.req('PATCH', `/api/machines/${id}`, { cookie, body: { remoteReply } });

  it('소유자만 바꿀 수 있다', async () => {
    expect((await patch(false, b.cookie)).status).toBe(404);
    expect((await patch(false, admin)).status).toBe(404);
    expect((await patch(false, a.cookie, 'none')).status).toBe(404);
    expect((await patch('no')).status).toBe(400);
    expect((await h.req('PATCH', `/api/machines/${a.machineId}`, { body: { remoteReply: false } })).status).toBe(401);
  });

  it('끄면 등록은 disabled, 답은 409 reply_disabled, 기다리던 요청·대기자는 gone', async () => {
    await send([h.ev('s1', 'Stop', {})]);
    await running('s2');
    const requestId = await ask('s2');
    const heldWait = wait(requestId);
    const heldInbox = inbox('s1');
    await until(() => h.deps.reply.size().requests === 1 && h.deps.reply.size().inbox === 1);
    await running('s3');
    expect((await reply('s3', { type: 'message', text: '꺼지기 전에 쌓인 글' })).status).toBe(200);

    h.published.length = 0;
    const res = await patch(false);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: a.machineId, remoteReply: false });
    const machineMsgs = h.published.filter((p) => p.msg.type === 'machine');
    expect(machineMsgs).toHaveLength(1);
    expect(machineMsgs[0]).toMatchObject({ userId: a.id, msg: { machine: { id: a.machineId, remoteReply: false } } });
    // 그 컴퓨터의 세션도 canReply=false로 다시 나간다
    expect(sessionMsgs('s2').at(-1)).toMatchObject({ canReply: false, pending: null });

    expect(await (await heldWait).json()).toEqual({ status: 'gone' });
    expect(await (await heldInbox).json()).toEqual({ status: 'gone' });
    expect(await view('s3')).toMatchObject({ canReply: false, queuedMessages: 0 }); // 쌓인 글은 버린다

    const asked = await h.req('POST', '/api/reply/ask', { token: a.token, body: askBody('s2') });
    expect(asked.status).toBe(200);
    expect(await asked.json()).toEqual({ disabled: true });
    expect(await (await inbox('s1')).json()).toEqual({ status: 'gone' });
    for (const body of [{ type: 'permission', requestId, behavior: 'allow' }, { type: 'message', text: '글' }]) {
      const r = await reply('s2', body);
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: 'reply_disabled' });
    }
  });

  it('다시 켜면 답할 수 있다', async () => {
    const res = await patch(true);
    expect(((await res.json()) as MachineView).remoteReply).toBe(true);
    expect((await view('s2')).canReply).toBe(true);
    const requestId = await ask('s2');
    expect((await reply('s2', { type: 'permission', requestId, behavior: 'allow' })).status).toBe(200);
  });
});

describe('플러그인 버전', () => {
  it('버전은 숫자 마디끼리 견준다', () => {
    expect(versionAtLeast('0.2.0', '0.2.0')).toBe(true);
    expect(versionAtLeast('0.10.0', '0.2.0')).toBe(true);
    expect(versionAtLeast('1.0', '0.2.0')).toBe(true);
    expect(versionAtLeast('0.2', '0.2.0')).toBe(true);
    expect(versionAtLeast('0.2.1-beta', '0.2.0')).toBe(true);
    expect(versionAtLeast('0.1.9', '0.2.0')).toBe(false);
    expect(versionAtLeast('0.1.10', '0.2.0')).toBe(false);
    expect(versionAtLeast('', '0.2.0')).toBe(false);
    expect(versionAtLeast('dev', '0.2.0')).toBe(false);
  });

  it('낮은 플러그인이면 canReply=false이고 답은 409 reply_disabled', async () => {
    await running('v1');
    const requestId = await ask('v1');
    // 옛 플러그인이 보낸 묶음으로 기기 버전이 0.1.0이 된다
    await h.ingest(a.token, h.batch([]));
    expect(await view('v1')).toMatchObject({ canReply: false, pending: null });
    const res = await reply('v1', { type: 'permission', requestId, behavior: 'allow' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'reply_disabled' });

    await send([]);
    expect(await view('v1')).toMatchObject({ canReply: true, pending: { id: requestId } });
  });

  it('종료·끊김 세션은 canReply=false', async () => {
    await send([h.ev('v2', 'Stop', {})]);
    expect((await view('v2')).canReply).toBe(true);
    await db.sql`UPDATE sessions SET status = 'lost' WHERE id = ${sid('v2')}`;
    expect((await view('v2')).canReply).toBe(false);
    expect((await reply('v2', { type: 'message', text: '글' })).status).toBe(409);
    await send([h.ev('v2', 'SessionEnd', { reason: 'exit' })]);
    expect((await view('v2')).canReply).toBe(false);
  });
});

describe('글 보내기', () => {
  const stored = (name: string) => db.sql<{ text: string; delivered: boolean }[]>`
    SELECT text, delivered_at IS NOT NULL AS delivered FROM session_messages WHERE session_id = ${sid(name)} ORDER BY created_at, id`;

  it('세션이 done이고 대기자가 붙어 있으면 바로 전달하고, 본문은 기록에 남기지 않는다', async () => {
    await send([h.ev('m1', 'Stop', { last_assistant_message: '끝났습니다' })]);
    const held = inbox('m1');
    await until(() => h.deps.reply.size().inbox === 1);
    h.published.length = 0;

    const res = await reply('m1', { type: 'message', text: '  이어서 테스트도 돌려 주세요  ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, queued: false });
    const got = (await (await held).json()) as { status: string; id: string; text: string };
    expect(got).toMatchObject({ status: 'message', text: '이어서 테스트도 돌려 주세요' });
    expect(got.id).toEqual(expect.any(String));

    expect(await stored('m1')).toEqual([{ text: '', delivered: true }]);
    expect(h.deps.reply.size().inbox).toBe(0);
    // 깨어난 세션은 다시 작업 중으로 보인다
    expect(await view('m1')).toMatchObject({ status: 'run', queuedMessages: 0 });
    expect(sessionMsgs('m1').at(-1)).toMatchObject({ status: 'run', queuedMessages: 0 });
  });

  it('작업 중이면 쌓였다가, Stop 뒤에 대기자에게 전달된다', async () => {
    await running('m2');
    h.published.length = 0;
    const res = await reply('m2', { type: 'message', text: '끝나면 커밋 메시지도 써 주세요' });
    expect(await res.json()).toEqual({ ok: true, queued: true });
    expect(await view('m2')).toMatchObject({ status: 'run', queuedMessages: 1 });
    expect(sessionMsgs('m2').at(-1)).toMatchObject({ queuedMessages: 1 });

    // 작업 중에는 대기자가 붙어도 넘기지 않는다
    expect(await (await inbox('m2', randomUUID(), a.token, quick)).json()).toEqual({ status: 'pending' });
    expect(await stored('m2')).toEqual([{ text: '끝나면 커밋 메시지도 써 주세요', delivered: false }]);

    // Stop 훅의 대기자가 이벤트보다 먼저 붙고, 뒤이어 Stop 이벤트가 도착한다
    const held = inbox('m2');
    await until(() => h.deps.reply.size().inbox === 1);
    h.advance(1000);
    await send([h.ev('m2', 'Stop', {})]);
    expect(await (await held).json()).toMatchObject({ status: 'message', text: '끝나면 커밋 메시지도 써 주세요' });
    expect(await stored('m2')).toEqual([{ text: '', delivered: true }]);
    expect((await view('m2')).queuedMessages).toBe(0);
  });

  it('세션이 done이 된 뒤에 대기자가 붙어도 쌓인 글을 바로 받는다(한 번에 하나, 보낸 순서대로)', async () => {
    await running('m3');
    await reply('m3', { type: 'message', text: '첫 글' });
    h.advance(1000);
    await reply('m3', { type: 'message', text: '둘째 글' });
    h.advance(1000);
    await send([h.ev('m3', 'Stop', {})]);
    expect((await view('m3')).queuedMessages).toBe(2);

    expect(await (await inbox('m3')).json()).toMatchObject({ status: 'message', text: '첫 글' });
    expect(await view('m3')).toMatchObject({ status: 'run', queuedMessages: 1 });
    // 깨어나 일하는 동안에는 다음 글을 넘기지 않는다
    expect(await (await inbox('m3', randomUUID(), a.token, quick)).json()).toEqual({ status: 'pending' });
    h.advance(1000);
    await send([h.ev('m3', 'Stop', {})]);
    expect(await (await inbox('m3')).json()).toMatchObject({ status: 'message', text: '둘째 글' });
    expect(await stored('m3')).toEqual([{ text: '', delivered: true }, { text: '', delivered: true }]);
  });

  it('세션 행이 아직 없으면 붙잡았다가 pending, 종료·끊김 세션의 대기자는 gone', async () => {
    expect(await (await inbox('아직-없는-세션', randomUUID(), a.token, quick)).json()).toEqual({ status: 'pending' });
    await send([h.ev('m9', 'Stop', {})]);
    await db.sql`UPDATE sessions SET status = 'lost' WHERE id = ${sid('m9')}`;
    expect(await (await inbox('m9')).json()).toEqual({ status: 'gone' });
    await send([h.ev('m9', 'Stop', {})]);
    const held = inbox('m9');
    await until(() => h.deps.reply.size().inbox === 1);
    h.advance(1000);
    await send([h.ev('m9', 'SessionEnd', { reason: 'exit' })]);
    expect(await (await held).json()).toEqual({ status: 'gone' });
    expect(await (await inbox('m9')).json()).toEqual({ status: 'gone' });
  });

  it('같은 세션에 새 대기자가 붙으면 옛 대기자는 gone', async () => {
    await send([h.ev('m4', 'Stop', {})]);
    const old = inbox('m4');
    await until(() => h.deps.reply.size().inbox === 1);
    const fresh = inbox('m4');
    expect(await (await old).json()).toEqual({ status: 'gone' });
    await until(() => h.deps.reply.size().inbox === 1);

    // 글은 새 대기자가 받는다
    expect(await (await reply('m4', { type: 'message', text: '새 대기자에게' })).json()).toEqual({ ok: true, queued: false });
    expect(await (await fresh).json()).toMatchObject({ status: 'message', text: '새 대기자에게' });
  });

  it('붙잡는 시간이 다 되면 pending으로 끝나고 대기자를 정리한다', async () => {
    await send([h.ev('m5', 'Stop', {})]);
    expect(await (await inbox('m5', randomUUID(), a.token, quick)).json()).toEqual({ status: 'pending' });
    expect(quick.deps.reply.size()).toEqual({ requests: 0, inbox: 0 });

    const requestId = await ask('m5');
    expect(await (await wait(requestId, a.token, quick)).json()).toEqual({ status: 'pending' });
    expect(quick.deps.reply.size()).toEqual({ requests: 0, inbox: 0 });
  });

  it('클라이언트가 연결을 끊으면 대기자를 정리한다', async () => {
    await send([h.ev('m6', 'Stop', {})]);
    const requestId = await ask('m6');
    const post = (path: string, body: unknown, signal: AbortSignal) => h.app.request(path, {
      method: 'POST', signal, body: JSON.stringify(body),
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
    });
    const gone = new AbortController();
    const heldInbox = post('/api/reply/inbox', { sessionId: 'm6', waiterId: randomUUID() }, gone.signal);
    const heldWait = post('/api/reply/wait', { requestId }, gone.signal);
    await until(() => h.deps.reply.size().inbox === 1 && h.deps.reply.size().requests === 1);

    gone.abort();
    await Promise.allSettled([heldInbox, heldWait]);
    await until(() => h.deps.reply.size().inbox === 0 && h.deps.reply.size().requests === 0);

    // 끊긴 대기자에게는 글을 넘기지 않고 쌓아 둔다
    expect(await (await reply('m6', { type: 'message', text: '끊긴 뒤의 글' })).json()).toEqual({ ok: true, queued: true });
    expect(await stored('m6')).toEqual([{ text: '끊긴 뒤의 글', delivered: false }]);
  });

  it('빈 글·너무 긴 글은 400, 4000자까지는 받는다', async () => {
    await running('m7');
    expect((await reply('m7', { type: 'message', text: '   ' })).status).toBe(400);
    expect((await reply('m7', { type: 'message', text: 'x'.repeat(MESSAGE_MAX_CHARS + 1) })).status).toBe(400);
    expect((await reply('m7', { type: 'unknown' })).status).toBe(400);
    expect((await reply('m7', { type: 'message', text: `비밀\u0007제어\n${'x'.repeat(MESSAGE_MAX_CHARS - 6)}` })).status).toBe(200);
    expect((await stored('m7'))[0]!.text).toHaveLength(MESSAGE_MAX_CHARS);
  });

  it('세션이 끝나면 전달하지 못한 글은 버린다', async () => {
    await running('m8');
    await reply('m8', { type: 'message', text: '전달되지 못할 글' });
    h.advance(1000);
    await send([h.ev('m8', 'SessionEnd', { reason: 'exit' })]);
    expect(await stored('m8')).toEqual([]);
  });
});

describe('정리', () => {
  const statusOf = async (requestId: string) =>
    (await db.sql<{ status: string }[]>`SELECT status FROM reply_requests WHERE id = ${requestId}`)[0]?.status;

  it('플러그인이 오래 다시 묻지 않은 요청은 gone이 되고 세션이 다시 나간다', async () => {
    await running('c1');
    const stale = await ask('c1');
    h.advance((REPLY_STALE_SECONDS - 30) * 1000);
    const alive = await ask('c1', { agentId: 'agent-1' });
    h.advance(31_000); // stale은 91초, alive는 31초 지남

    h.published.length = 0;
    // (앞선 테스트들이 남긴 오래된 요청도 함께 치워진다)
    expect(await sweepStaleRequests(h.deps)).toBeGreaterThanOrEqual(1);
    expect(await statusOf(stale)).toBe('gone');
    expect(await statusOf(alive)).toBe('pending');
    expect(sessionMsgs('c1')).toHaveLength(1);
    expect(sessionMsgs('c1')[0]!.pending).toMatchObject({ id: alive, more: 0 });
    expect(await (await wait(stale)).json()).toEqual({ status: 'gone' });
    expect(await sweepStaleRequests(h.deps)).toBe(0);
  });

  it('wait를 부를 때마다 polled_at이 갱신돼 정리 대상에서 빠진다', async () => {
    await running('c2');
    const requestId = await ask('c2');
    for (let i = 0; i < 3; i++) {
      h.advance(60_000);
      const held = wait(requestId);
      await until(() => h.deps.reply.size().requests === 1);
      // 60초마다 다시 물었으니 정리가 돌아도 치워지지 않는다
      await sweepStaleRequests(h.deps);
      expect(await statusOf(requestId)).toBe('pending');
      h.deps.reply.notifyRequests([requestId]); // 붙잡힌 요청을 풀어 준다
      expect(await (await held).json()).toEqual({ status: 'pending' });
    }
    expect((await view('c2')).pending!.id).toBe(requestId);
  });

  it('정리가 돌기 전이라도 오래된 요청에 답하면 409 no_pending', async () => {
    await running('c3');
    const requestId = await ask('c3');
    h.advance((REPLY_STALE_SECONDS + 1) * 1000);
    const res = await reply('c3', { type: 'permission', requestId, behavior: 'allow' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'no_pending' });
    expect((await view('c3')).pending).toBeNull();
  });

  it('세션을 지우면 그 세션의 요청과 글도 지운다', async () => {
    await running('c4');
    const requestId = await ask('c4');
    await reply('c4', { type: 'message', text: '쌓인 글' });
    await db.sql`UPDATE sessions SET status = 'lost' WHERE id = ${sid('c4')}`;
    const held = wait(requestId);
    await until(() => h.deps.reply.size().requests === 1);

    expect((await h.req('DELETE', `/api/sessions/${encodeURIComponent(sid('c4'))}`, { cookie: a.cookie })).status).toBe(200);
    expect((await db.sql`SELECT 1 FROM reply_requests WHERE session_id = ${sid('c4')}`).length).toBe(0);
    expect((await db.sql`SELECT 1 FROM session_messages WHERE session_id = ${sid('c4')}`).length).toBe(0);
    expect(await (await held).json()).toEqual({ status: 'gone' });
    expect((await wait(requestId)).status).toBe(404);
  });

  it('끝난 요청과 전달된 글은 7일 뒤 지운다', async () => {
    await send([h.ev('c5', 'Stop', {})]);
    await reply('c5', { type: 'message', text: '전달될 글' });
    expect(await (await inbox('c5')).json()).toMatchObject({ status: 'message' });
    const answered = await ask('c5');
    await reply('c5', { type: 'permission', requestId: answered, behavior: 'allow' });
    const count = async () => {
      const [r] = await db.sql<{ requests: number; messages: number }[]>`
        SELECT (SELECT count(*)::int FROM reply_requests WHERE session_id = ${sid('c5')}) AS requests,
               (SELECT count(*)::int FROM session_messages WHERE session_id = ${sid('c5')}) AS messages`;
      return r;
    };
    expect(await count()).toEqual({ requests: 1, messages: 1 });

    h.advance(6 * DAY);
    await runCleanup(h.deps);
    expect(await count()).toEqual({ requests: 1, messages: 1 });
    // 아직 기다리는 요청은 지우지 않는다
    const pending = await ask('c5');

    h.advance(2 * DAY);
    const result = await runCleanup(h.deps);
    expect(result.replyRequests).toBeGreaterThanOrEqual(1);
    expect(result.sessionMessages).toBeGreaterThanOrEqual(1);
    expect(await count()).toEqual({ requests: 1, messages: 0 });
    expect((await db.sql`SELECT 1 FROM reply_requests WHERE id = ${pending} AND status = 'pending'`).length).toBe(1);
  });
});

describe('원격 제어 링크', () => {
  const URL_A = 'https://claude.ai/code/session_01AbCdEf';

  it('remoteUrl을 저장하고, 필드가 없으면 유지하고, null이면 지운다', async () => {
    // 앞의 정리 테스트가 시계를 여러 날 넘겨 로그인 쿠키가 만료됐을 수 있다
    a.cookie = await h.login('a@example.com');
    await send([h.ev('r1', 'SessionStart', {})]);
    expect((await view('r1')).remoteUrl).toBeNull();

    h.published.length = 0;
    await send([h.ev('r1', 'UserPromptSubmit', { prompt: 'x' }, { remoteUrl: URL_A })]);
    expect((await view('r1')).remoteUrl).toBe(URL_A);
    expect(sessionMsgs('r1').at(-1)!.remoteUrl).toBe(URL_A);

    // 옛 플러그인(필드 없음)의 이벤트는 그대로 둔다
    await send([h.ev('r1', 'PostToolUse', {})]);
    expect((await view('r1')).remoteUrl).toBe(URL_A);

    await send([h.ev('r1', 'Stop', {}, { remoteUrl: null })]);
    expect((await view('r1')).remoteUrl).toBeNull();
  });

  it('claude.ai 주소가 아니면 받지 않는다(400)', async () => {
    const res = await send([h.ev('r2', 'Stop', {}, { remoteUrl: 'https://example.com/code/session_x' })]);
    expect(res.status).toBe(400);
  });
});

describe('스트림', () => {
  it('요청 등록·답이 SSE로 session 메시지로 나간다', async () => {
    await running('e1');
    const res = await h.req('GET', '/api/stream', { cookie: a.cookie });
    const r = sseReader(res);
    try {
      expect((await r.nextMessage()).type).toBe('snapshot');
      const requestId = await ask('e1');
      const asked = await r.nextMessage();
      expect(asked).toMatchObject({ type: 'session', session: { id: sid('e1'), status: 'wait', pending: { id: requestId } } });

      await reply('e1', { type: 'permission', requestId, behavior: 'allow' });
      const answered = await r.nextMessage();
      expect(answered).toMatchObject({ type: 'session', session: { id: sid('e1'), status: 'run', pending: null } });
    } finally {
      await r.close();
    }
  });
});
