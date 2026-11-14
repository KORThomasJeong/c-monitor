// 관리자(3차): 남의 대시보드 보기(?user=, 스트림 포함)는 읽기 전용이고 모든 쓰기가 서버에서 막힌다(Review Focus 5).
// 모든 컴퓨터 목록·원격 답장 스위치·연결 해제.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdminMachineView, DashboardSnapshot, ReplyAsk, StreamMessage } from '@c-monitor/shared';
import { ADMIN, makeHarness, makeTestDb, sseReader, type TestDb } from './helpers';

let db: TestDb;
let h: ReturnType<typeof makeHarness>;
let adminCookie: string;
let a: { cookie: string; id: string; token: string; machineId: string };
let b: { cookie: string; id: string; token: string; machineId: string };

const MACHINE = { name: 'pc-a', os: 'win32', pluginVersion: '0.2.0' };
const sid = (name: string) => `${a.machineId}:${name}`;
const enc = (name: string) => encodeURIComponent(sid(name));
const send = (events: Parameters<typeof h.batch>[0], extra: Parameters<typeof h.batch>[1] = {}) =>
  h.ingest(a.token, { ...h.batch(events, extra), machine: MACHINE });
const askBody = (name: string): ReplyAsk => ({
  sessionId: name, kind: 'permission', toolName: 'Bash', toolInput: { command: 'rm -rf build' },
  agentId: null, sessionAllow: null, at: h.clock.now.toISOString(),
});

beforeAll(async () => {
  db = await makeTestDb();
  h = makeHarness(db, { pingMs: 40, replyPollMs: 200 });
  adminCookie = await h.login(ADMIN);
  const ua = await h.activeUser('a@example.com');
  const ub = await h.activeUser('b@example.com');
  a = { ...ua, ...(await h.connect(ua.cookie, 'pc-a')) };
  b = { ...ub, ...(await h.connect(ub.cookie, 'pc-b')) };
  await send([h.ev('s1', 'UserPromptSubmit', { prompt: '질문' }, { account: 'a-claude@example.com' })], {
    transcript: [{ sessionId: 's1', seq: 0, lines: [h.line('대화')] }],
  });
  expect((await h.req('POST', '/api/reply/ask', { token: a.token, body: askBody('s1') })).status).toBe(200);
  await send([h.ev('old', 'SessionEnd', { reason: 'exit' })]);
});
afterAll(async () => { await db.drop(); });

describe('관리자가 남의 대시보드 보기', () => {
  it('GET /api/sessions?user= 는 그 사용자의 세션을 원격 답장 정보 없이 보여 준다(일반 사용자는 403)', async () => {
    const snap = (await (await h.req('GET', `/api/sessions?user=${a.id}`, { cookie: adminCookie })).json()) as DashboardSnapshot;
    expect(snap.sessions.find((s) => s.id === sid('s1'))).toMatchObject({ status: 'wait', pending: null, canReply: false, queuedMessages: 0 });
    expect(snap.machines.map((m) => m.id)).toEqual([a.machineId]);
    // 소유자 본인에게는 pending이 보인다
    const own = (await (await h.req('GET', '/api/sessions', { cookie: a.cookie })).json()) as DashboardSnapshot;
    expect(own.sessions.find((s) => s.id === sid('s1'))!.pending).not.toBeNull();
    expect((await h.req('GET', `/api/sessions?user=${a.id}`, { cookie: b.cookie })).status).toBe(403);
  });

  it('GET /api/stream?user= 는 관리자만, 그 사용자의 변화를 읽기 전용 모양으로 받는다', async () => {
    expect((await h.req('GET', `/api/stream?user=${a.id}`, { cookie: b.cookie })).status).toBe(403);
    expect((await h.req('GET', '/api/stream?user=nobody', { cookie: adminCookie })).status).toBe(404);
    const r = sseReader(await h.req('GET', `/api/stream?user=${a.id}`, { cookie: adminCookie }));
    try {
      const first = await r.nextMessage();
      expect(first.type).toBe('snapshot');
      const s1 = first.type === 'snapshot' ? first.sessions.find((s) => s.id === sid('s1')) : undefined;
      expect(s1).toMatchObject({ pending: null, canReply: false });

      // a의 세션에 새 요청 → 관리자에게도 session이 오지만 pending은 비어 있다
      await send([h.ev('s2', 'UserPromptSubmit', { prompt: '둘째' })]);
      await h.req('POST', '/api/reply/ask', { token: a.token, body: askBody('s2') });
      let msg: StreamMessage;
      do msg = await r.nextMessage(); while (!(msg.type === 'session' && msg.session.id === sid('s2') && msg.session.status === 'wait'));
      expect(msg.session).toMatchObject({ pending: null, canReply: false, queuedMessages: 0 });
      // 다른 사용자(b)의 변화는 오지 않는다 — 다음으로 a의 대화 줄이 와야 한다
      await h.ingest(b.token, { ...h.batch([h.ev('bs', 'UserPromptSubmit', { prompt: 'B' })]), machine: { ...MACHINE, name: 'pc-b' } });
      await send([], { transcript: [{ sessionId: 's1', seq: 1, lines: [h.line('새 줄')] }] });
      do msg = await r.nextMessage(); while (msg.type === 'machine');
      expect(msg).toMatchObject({ type: 'log', sessionId: sid('s1') });
    } finally {
      await r.close();
    }
  });

  it('관리자가 열람 중 관리자 권한을 잃으면 스트림이 끝난다', async () => {
    const other = await h.activeUser('second-admin@example.com');
    await db.sql`UPDATE users SET role = 'admin' WHERE id = ${other.id}`;
    const r = sseReader(await h.req('GET', `/api/stream?user=${a.id}`, { cookie: other.cookie }));
    await r.nextMessage();
    await db.sql`UPDATE users SET role = 'user' WHERE id = ${other.id}`;
    const ended = await Promise.race([
      (async () => { try { for (;;) await r.next(); } catch { return true; } })(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    expect(ended).toBe(true);
  });

  it('남의 세션·컴퓨터에 대한 쓰기는 관리자라도 모두 404이고 아무것도 바뀌지 않는다', async () => {
    const [req] = await db.sql<{ id: string }[]>`SELECT id FROM reply_requests WHERE session_id = ${sid('s1')} AND status = 'pending'`;
    const writes: [string, string, unknown?][] = [
      ['POST', `/api/sessions/${enc('s1')}/reply`, { type: 'permission', requestId: req!.id, behavior: 'allow' }],
      ['POST', `/api/sessions/${enc('s1')}/reply`, { type: 'message', text: '관리자의 글' }],
      ['POST', `/api/sessions/${enc('s1')}/seen`],
      ['PATCH', `/api/sessions/${enc('s1')}`, { telegram: false }],
      ['DELETE', `/api/sessions/${enc('old')}`],
      ['POST', `/api/sessions/${enc('s1')}/shares`, { kind: 'link', expiresIn: '1h' }],
      ['GET', `/api/sessions/${enc('s1')}/shares`],
      ['PATCH', `/api/machines/${a.machineId}`, { remoteReply: false }],
      ['DELETE', `/api/machines/${a.machineId}`],
      ['PATCH', `/api/accounts/${encodeURIComponent('a-claude@example.com')}`, { alias: '관리자가 바꿈' }],
    ];
    for (const [method, path, body] of writes) {
      expect([method, path, (await h.req(method, path, { cookie: adminCookie, body })).status]).toEqual([method, path, 404]);
    }
    const [s] = await db.sql<{ seen: boolean; telegram: boolean }[]>`SELECT seen, telegram FROM sessions WHERE id = ${sid('s1')}`;
    expect(s).toEqual({ seen: false, telegram: true });
    expect((await db.sql`SELECT 1 FROM sessions WHERE id = ${sid('old')}`).length).toBe(1);
    expect((await db.sql`SELECT status FROM reply_requests WHERE id = ${req!.id}`)[0]).toEqual({ status: 'pending' });
    expect((await db.sql`SELECT 1 FROM session_messages`).length).toBe(0);
    expect((await db.sql`SELECT 1 FROM shares`).length).toBe(0);
    expect((await db.sql`SELECT alias FROM accounts WHERE user_id = ${a.id}`)[0]).toEqual({ alias: null });
    const [m] = await db.sql<{ remote_reply: boolean; revoked_at: Date | null }[]>`SELECT remote_reply, revoked_at FROM machines WHERE id = ${a.machineId}`;
    expect(m).toEqual({ remote_reply: true, revoked_at: null });
    // 설정은 늘 자기 것만 바뀐다(남의 설정을 고치는 경로가 없다)
    await h.req('PUT', '/api/settings', { cookie: adminCookie, body: { lostMinutes: 33 } });
    expect((await (await h.req('GET', '/api/settings', { cookie: a.cookie })).json())).toMatchObject({ lostMinutes: 10 });
  });

  it('읽기(대화·검색·답 기록)는 관리자에게 허용된다', async () => {
    for (const rest of ['/log', '/replies', '/search?q=%EB%8C%80%ED%99%94']) {
      expect([rest, (await h.req('GET', `/api/sessions/${enc('s1')}${rest}`, { cookie: adminCookie })).status]).toEqual([rest, 200]);
    }
  });
});

describe('관리자: 모든 컴퓨터', () => {
  it('모든 사용자의 컴퓨터를 소유자·계정과 함께 보여 준다', async () => {
    const res = await h.req('GET', '/api/admin/machines', { cookie: adminCookie });
    expect(res.status).toBe(200);
    const { machines } = (await res.json()) as { machines: AdminMachineView[] };
    expect(machines.find((m) => m.id === a.machineId)).toMatchObject({
      name: 'pc-a', os: 'win32', pluginVersion: '0.2.0', online: true, remoteReply: true,
      ownerId: a.id, ownerEmail: 'a@example.com', account: 'a-claude@example.com',
    });
    expect(machines.find((m) => m.id === b.machineId)).toMatchObject({ ownerEmail: 'b@example.com', account: null });
  });

  it('원격 답장 스위치를 바꾸면 소유자에게 알리고 기다리던 요청을 치운다, 없는 컴퓨터는 404', async () => {
    h.published.length = 0;
    const res = await h.req('PATCH', `/api/admin/machines/${a.machineId}`, { cookie: adminCookie, body: { remoteReply: false } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: a.machineId, remoteReply: false, ownerEmail: 'a@example.com' });
    expect(h.published.some((p) => p.userId === a.id && p.msg.type === 'machine' && !p.msg.machine.remoteReply)).toBe(true);
    expect((await db.sql`SELECT 1 FROM reply_requests WHERE machine_id = ${a.machineId} AND status = 'pending'`).length).toBe(0);
    expect((await h.req('PATCH', `/api/admin/machines/${a.machineId}`, { cookie: adminCookie, body: { remoteReply: true } })).status).toBe(200);
    expect((await h.req('PATCH', '/api/admin/machines/none', { cookie: adminCookie, body: { remoteReply: true } })).status).toBe(404);
    expect((await h.req('PATCH', `/api/admin/machines/${a.machineId}`, { cookie: adminCookie, body: { remoteReply: 'x' } })).status).toBe(400);
  });

  it('연결 해제하면 그 기기 토큰은 401, 목록에서 빠진다', async () => {
    const extra = await h.connect(b.cookie, 'pc-b2');
    expect((await h.req('DELETE', `/api/admin/machines/${extra.machineId}`, { cookie: adminCookie })).status).toBe(200);
    expect((await h.ingest(extra.token, h.batch([]))).status).toBe(401);
    expect((await h.req('POST', '/api/reply/inbox', { token: extra.token, body: { sessionId: 'x', waiterId: randomUUID() } })).status).toBe(401);
    const { machines } = (await (await h.req('GET', '/api/admin/machines', { cookie: adminCookie })).json()) as { machines: AdminMachineView[] };
    expect(machines.map((m) => m.id)).not.toContain(extra.machineId);
    expect((await h.req('DELETE', `/api/admin/machines/${extra.machineId}`, { cookie: adminCookie })).status).toBe(404);
  });
});
