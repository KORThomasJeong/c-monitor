// 원격 답장 3차: 웹 답 기록(GET /replies·스트림 reply), 글 수신 확인(ack, 0.3.0 이상), 상태줄의 컨텍스트 %·비용(sessionStats).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DashboardSnapshot, HookEvent, IngestBatch, ReplyAsk, ReplyRecord, SessionView, StreamMessage } from '@c-monitor/shared';
import { ADMIN, makeHarness, makeTestDb, type TestDb } from './helpers';

let db: TestDb;
let h: ReturnType<typeof makeHarness>;
let quick: ReturnType<typeof makeHarness>;
let adminCookie: string;
/** a: 0.3.0 플러그인(ack 보냄) */
let a: { cookie: string; id: string; token: string; machineId: string };
/** a의 두 번째 컴퓨터: 0.2.0 플러그인(ack 없음) */
let old: { token: string; machineId: string };
let b: { cookie: string; id: string; token: string; machineId: string };

const NEW = { name: 'pc-new', os: 'win32', pluginVersion: '0.3.0' };
const OLD = { name: 'pc-old', os: 'linux', pluginVersion: '0.2.5' };

const sid = (name: string, machineId = a.machineId) => `${machineId}:${name}`;
const enc = (name: string, machineId = a.machineId) => encodeURIComponent(sid(name, machineId));
const send = (events: HookEvent[], extra: Partial<IngestBatch> = {}, token = a.token, machine = NEW) =>
  h.ingest(token, { ...h.batch(events, extra), machine });
const inbox = (name: string, token = a.token, on = h) =>
  on.req('POST', '/api/reply/inbox', { token, body: { sessionId: name, waiterId: randomUUID() } });
const ack = (name: string, id: string, token = a.token) => h.req('POST', '/api/reply/inbox/ack', { token, body: { sessionId: name, id } });
const reply = (name: string, body: unknown, cookie = a.cookie, machineId = a.machineId) =>
  h.req('POST', `/api/sessions/${enc(name, machineId)}/reply`, { cookie, body });
const replies = async (name: string, cookie = a.cookie) =>
  ((await (await h.req('GET', `/api/sessions/${enc(name)}/replies`, { cookie })).json()) as { replies: ReplyRecord[] }).replies;
async function view(name: string, machineId = a.machineId): Promise<SessionView> {
  const snap = (await (await h.req('GET', '/api/sessions', { cookie: a.cookie })).json()) as DashboardSnapshot;
  return snap.sessions.find((s) => s.id === sid(name, machineId))!;
}
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error('조건을 기다리다 시간이 다 됐습니다');
}
async function ask(name: string, over: Partial<ReplyAsk> = {}): Promise<string> {
  const res = await h.req('POST', '/api/reply/ask', {
    token: a.token,
    body: { sessionId: name, kind: 'permission', toolName: 'Bash', toolInput: { command: 'ls' }, agentId: null, sessionAllow: '이 세션 동안 ls 허용', at: h.clock.now.toISOString(), ...over },
  });
  return ((await res.json()) as { requestId: string }).requestId;
}
const stored = (name: string, machineId = a.machineId) => db.sql<{ text: string; delivered: boolean; handed: boolean }[]>`
  SELECT text, delivered_at IS NOT NULL AS delivered, handed_at IS NOT NULL AS handed
  FROM session_messages WHERE session_id = ${sid(name, machineId)} ORDER BY created_at, id`;

beforeAll(async () => {
  db = await makeTestDb();
  h = makeHarness(db, { replyPollMs: 15_000 });
  quick = makeHarness(db, { replyPollMs: 60, now: () => h.deps.now() });
  adminCookie = await h.login(ADMIN);
  const ua = await h.activeUser('a@example.com');
  const ub = await h.activeUser('b@example.com');
  a = { ...ua, ...(await h.connect(ua.cookie, 'pc-new')) };
  old = await h.connect(ua.cookie, 'pc-old');
  b = { ...ub, ...(await h.connect(ub.cookie, 'pc-b')) };
  await send([]);
  await send([], {}, old.token, OLD);
  await send([], {}, b.token, { ...NEW, name: 'pc-b' });
});
afterAll(async () => { await db.drop(); });

describe('웹 답 기록', () => {
  it('승인·거부·질문 답·글마다 기록이 남고(오래된 순), 소유자에게 reply 메시지가 나간다', async () => {
    await send([h.ev('r1', 'UserPromptSubmit', { prompt: '시작' })]);
    const p1 = await ask('r1');
    h.published.length = 0;
    expect((await reply('r1', { type: 'permission', requestId: p1, behavior: 'allow' })).status).toBe(200);
    const msgs = h.published.filter((p) => p.msg.type === 'reply');
    expect(msgs.map((p) => p.userId)).toEqual([a.id]);
    const first = (msgs[0]!.msg as Extract<StreamMessage, { type: 'reply' }>);
    expect(first).toEqual({ type: 'reply', sessionId: sid('r1'), reply: { id: expect.any(String), at: h.clock.now.toISOString(), source: 'web', kind: 'permission', label: '허용' } });

    h.advance(1000);
    const p2 = await ask('r1');
    await reply('r1', { type: 'permission', requestId: p2, behavior: 'allow_session' });
    h.advance(1000);
    const p3 = await ask('r1');
    await reply('r1', { type: 'permission', requestId: p3, behavior: 'deny', message: '  그 대신\n테스트만 ' });
    h.advance(1000);
    const q = await ask('r1', { kind: 'question', toolName: 'AskUserQuestion', toolInput: {}, sessionAllow: null, questions: [
      { question: '색?', options: [{ label: '빨강' }, { label: '파랑' }] }, { question: '크기?', options: [{ label: '큼' }] },
    ] });
    await reply('r1', { type: 'answer', requestId: q, answers: { '색?': '파랑', '크기?': '큼' } });
    h.advance(1000);
    await reply('r1', { type: 'message', text: '가'.repeat(300) });

    const list = await replies('r1');
    expect(list.map((r) => [r.source, r.kind, r.label])).toEqual([
      ['web', 'permission', '허용'],
      ['web', 'permission', '이 세션 동안 허용'],
      ['web', 'permission', '거부: 그 대신 테스트만'],
      ['web', 'answer', '파랑 / 큼'],
      ['web', 'message', '가'.repeat(200)],
    ]);
    expect(list.map((r) => r.at)).toEqual([...list.map((r) => r.at)].sort());
  });

  it('이미 끝난 요청에 답하거나(409) 남의 세션이면(404) 기록하지 않는다', async () => {
    const before = (await replies('r1')).length;
    expect((await reply('r1', { type: 'permission', requestId: 'nope', behavior: 'allow' })).status).toBe(409);
    expect((await reply('r1', { type: 'message', text: 'B의 글' }, b.cookie)).status).toBe(404);
    expect((await reply('r1', { type: 'message', text: '관리자의 글' }, adminCookie)).status).toBe(404);
    expect((await replies('r1')).length).toBe(before);
  });

  it('기록은 소유자·관리자만 보고 남은 404, 세션을 지우면 함께 지워진다', async () => {
    expect((await h.req('GET', `/api/sessions/${enc('r1')}/replies`, { cookie: b.cookie })).status).toBe(404);
    expect((await h.req('GET', `/api/sessions/${enc('r1')}/replies`, { cookie: adminCookie })).status).toBe(200);
    expect((await h.req('GET', `/api/sessions/${enc('none')}/replies`, { cookie: a.cookie })).status).toBe(404);
    await send([h.ev('r1', 'SessionEnd', { reason: 'exit' })]);
    expect((await h.req('DELETE', `/api/sessions/${enc('r1')}`, { cookie: a.cookie })).status).toBe(200);
    expect((await db.sql`SELECT 1 FROM reply_records WHERE session_id = ${sid('r1')}`).length).toBe(0);
  });
});

describe('글 수신 확인(ack)', () => {
  it('0.3.0 이상: 넘겨도 ack 전에는 전달 대기(본문 유지·세션 done), ack 하면 본문을 지우고 run이 된다', async () => {
    await send([h.ev('k1', 'Stop', {})]);
    const held = inbox('k1');
    await until(() => h.deps.reply.size().inbox === 1);
    expect(await (await reply('k1', { type: 'message', text: '다음 일' })).json()).toEqual({ ok: true, queued: false });
    const got = (await (await held).json()) as { status: string; id: string; text: string };
    expect(got).toMatchObject({ status: 'message', text: '다음 일' });
    expect(await stored('k1')).toEqual([{ text: '다음 일', delivered: false, handed: true }]);
    expect(await view('k1')).toMatchObject({ status: 'done', queuedMessages: 1 });

    h.published.length = 0;
    const res = await ack('k1', got.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await stored('k1')).toEqual([{ text: '', delivered: true, handed: true }]);
    expect(await view('k1')).toMatchObject({ status: 'run', queuedMessages: 0 });
    expect(h.published.some((p) => p.msg.type === 'session' && p.msg.session.id === sid('k1') && p.msg.session.status === 'run')).toBe(true);
    // 같은 ack를 다시 보내도 ok
    expect((await ack('k1', got.id)).status).toBe(200);
  });

  it('ack가 60초 안에 없으면 다음 대기자에게 같은 글을 다시 주고, 그 전에는 뒤 글도 건너뛰지 않는다', async () => {
    await send([h.ev('k2', 'Stop', {})]);
    await reply('k2', { type: 'message', text: '첫 글' });
    h.advance(1000);
    await reply('k2', { type: 'message', text: '둘째 글' });
    const firstTry = (await (await inbox('k2')).json()) as { status: string; id: string; text: string };
    expect(firstTry).toMatchObject({ status: 'message', text: '첫 글' });
    // 59초 뒤: 아직 ack를 기다린다 — 둘째 글을 먼저 주지도 않는다
    h.advance(59_000);
    expect(await (await inbox('k2', a.token, quick)).json()).toEqual({ status: 'pending' });
    // 61초 뒤: 같은 글(같은 id)을 다시 준다
    h.advance(2_000);
    const retry = (await (await inbox('k2')).json()) as { status: string; id: string; text: string };
    expect(retry).toEqual({ status: 'message', id: firstTry.id, text: '첫 글' });
    expect((await ack('k2', retry.id)).status).toBe(200);
    // 세션이 다시 끝나면 둘째 글
    await send([h.ev('k2', 'Stop', {})]);
    expect(await (await inbox('k2')).json()).toMatchObject({ status: 'message', text: '둘째 글' });
  });

  it('모르는 id·남의 기기·다른 세션의 ack는 404, 넘기지 않은 글도 404', async () => {
    await send([h.ev('k3', 'UserPromptSubmit', { prompt: '작업 중' })]);
    await reply('k3', { type: 'message', text: '쌓인 글' });
    const [m] = await db.sql<{ id: string }[]>`SELECT id FROM session_messages WHERE session_id = ${sid('k3')}`;
    expect((await ack('k3', m!.id)).status).toBe(404);
    expect((await ack('k3', 'unknown-id')).status).toBe(404);
    const [handed] = await db.sql<{ id: string }[]>`SELECT id FROM session_messages WHERE session_id = ${sid('k1')}`;
    expect((await ack('k3', handed!.id)).status).toBe(404);
    expect((await ack('k1', handed!.id, b.token)).status).toBe(404);
    expect((await h.req('POST', '/api/reply/inbox/ack', { token: a.token, body: { sessionId: 'k1' } })).status).toBe(400);
    expect((await h.req('POST', '/api/reply/inbox/ack', { body: { sessionId: 'k1', id: handed!.id } })).status).toBe(401);
  });

  it('0.3.0 미만: 넘긴 순간 전달 완료(본문 삭제·run) — 예전 동작 그대로', async () => {
    await send([h.ev('o1', 'Stop', {})], {}, old.token, OLD);
    await reply('o1', { type: 'message', text: '옛 기기에 보낸 글' }, a.cookie, old.machineId);
    expect(await (await inbox('o1', old.token)).json()).toMatchObject({ status: 'message', text: '옛 기기에 보낸 글' });
    expect(await stored('o1', old.machineId)).toEqual([{ text: '', delivered: true, handed: true }]);
    expect(await view('o1', old.machineId)).toMatchObject({ status: 'run', queuedMessages: 0 });
  });
});

describe('컨텍스트 %·비용(sessionStats)', () => {
  const stat = (sessionId: string, contextPct: number | null, costUsd: number | null, at = h.clock.now.toISOString()) =>
    ({ sessionId, contextPct, costUsd, at });

  it('내 기기 세션의 값을 저장해 뷰에 싣고, 바뀐 때만 session을 내보낸다', async () => {
    await send([h.ev('c1', 'UserPromptSubmit', { prompt: '시작' })]);
    expect(await view('c1')).toMatchObject({ contextPct: null, costUsd: null });
    h.published.length = 0;
    expect((await send([], { sessionStats: [stat('c1', 42.5, 1.25)] })).status).toBe(200);
    expect(await view('c1')).toMatchObject({ contextPct: 42.5, costUsd: 1.25 });
    const pubs = h.published.filter((p) => p.msg.type === 'session' && p.msg.session.id === sid('c1'));
    expect(pubs.map((p) => p.userId)).toEqual([a.id]);
    expect((pubs[0]!.msg as Extract<StreamMessage, { type: 'session' }>).session).toMatchObject({ contextPct: 42.5, costUsd: 1.25 });

    h.published.length = 0;
    h.advance(60_000);
    await send([], { sessionStats: [stat('c1', 42.5, 1.25)] });
    expect(h.published.filter((p) => p.msg.type === 'session')).toEqual([]);
    // 알 수 없으면 null로
    await send([], { sessionStats: [stat('c1', null, 1.5)] });
    expect(await view('c1')).toMatchObject({ contextPct: null, costUsd: 1.5 });
  });

  it('모르는 세션·남의 세션 이름은 조용히 건너뛴다(400 아님), 세션을 만들지도 않는다', async () => {
    await send([h.ev('bx', 'UserPromptSubmit', { prompt: 'B' })], {}, b.token, { ...NEW, name: 'pc-b' });
    const res = await send([], { sessionStats: [stat('unknown-session', 10, 0.1), stat('bx', 99, 99)] });
    expect(res.status).toBe(200);
    expect((await db.sql`SELECT 1 FROM sessions WHERE id = ${sid('unknown-session')}`).length).toBe(0);
    const [bRow] = await db.sql<{ context_pct: number | null }[]>`SELECT context_pct FROM sessions WHERE id = ${sid('bx', b.machineId)}`;
    expect(bRow!.context_pct).toBeNull();
  });

  it('같은 묶음의 새 세션 이벤트와 함께 오면 반영되고, 더 오래된 값은 무시한다', async () => {
    const t0 = h.clock.now.toISOString();
    await send([h.ev('c2', 'UserPromptSubmit', { prompt: '시작' })], { sessionStats: [stat('c2', 5, 0.01, t0), stat('c2', 7, 0.02, t0)] });
    expect(await view('c2')).toMatchObject({ contextPct: 7, costUsd: 0.02 });
    h.advance(60_000);
    await send([], { sessionStats: [stat('c2', 9, 0.03)] });
    await send([], { sessionStats: [stat('c2', 1, 0.001, t0)] });
    expect(await view('c2')).toMatchObject({ contextPct: 9, costUsd: 0.03 });
  });

  it('범위를 벗어난 값은 묶음 전체가 400(계약의 스키마)', async () => {
    expect((await send([], { sessionStats: [stat('c1', 150, 1)] })).status).toBe(400);
    expect((await send([], { sessionStats: [stat('c1', 10, -1)] })).status).toBe(400);
  });
});
