// 계정(3차): 가입 고지 동의, 탈퇴·탈퇴 취소·완전 삭제(Review Focus 2), 관리자의 미리 추가·권한·한도·삭제,
// 저장 용량 계산·한도 정리(Review Focus 3), 보관 기간 0 = 지우지 않음.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_QUOTA_MB, WITHDRAW_DAYS,
  type AdminStorageView, type AdminUserView, type MeResponse, type StorageMe,
} from '@c-monitor/shared';
import { runCleanup } from '../src/jobs/cleanup';
import { createPushHub } from '../src/notify/push';
import { ADMIN, DAY, HOUR, fakePush, makeHarness, makeTestDb, type TestDb } from './helpers';

const fp = fakePush();
let db: TestDb;
let h: ReturnType<typeof makeHarness>;
let adminCookie: string;
let adminId: string;

const MACHINE = { name: 'pc', os: 'win32', pluginVersion: '0.2.0' };
const me = async (cookie: string) => (await (await h.req('GET', '/api/me', { cookie })).json()) as MeResponse;
const users = async () => ((await (await h.req('GET', '/api/admin/users', { cookie: adminCookie })).json()) as { users: AdminUserView[] }).users;

/** 컴퓨터까지 연결한 승인된 사용자. */
async function member(email: string) {
  const u = await h.activeUser(email);
  const m = await h.connect(u.cookie, `pc-${email}`);
  await h.ingest(m.token, { ...h.batch([]), machine: MACHINE });
  return { ...u, ...m };
}

beforeAll(async () => {
  db = await makeTestDb();
  h = makeHarness(db, { push: createPushHub({ sender: fp.sender, waitGraceMs: 0 }), replyPollMs: 5_000, diskFree: async () => 123_456_789 });
  adminCookie = await h.login(ADMIN);
  adminId = await h.userId(ADMIN);
});
afterAll(async () => { await db.drop(); });

describe('가입 고지 동의', () => {
  it('처음 로그인하면 consentedAt이 비어 있고, 동의하면 시각이 남으며 다시 동의해도 바뀌지 않는다', async () => {
    const cookie = await h.login('consent@example.com');
    expect((await me(cookie)).user).toMatchObject({ status: 'pending', consentedAt: null, deleteAt: null });
    const res = await h.req('POST', '/api/me/consent', { cookie });
    expect(res.status).toBe(200);
    const at = h.clock.now.toISOString();
    expect(((await res.json()) as MeResponse).user.consentedAt).toBe(at);
    h.advance(1000);
    await h.req('POST', '/api/me/consent', { cookie });
    expect((await me(cookie)).user.consentedAt).toBe(at);
    expect((await h.req('POST', '/api/me/consent')).status).toBe(401);
  });

  it('승인 대기 수에는 동의한 신청만 들어간다', async () => {
    const count = async () => (await me(adminCookie)).pendingCount!;
    const before = await count();
    const cookie = await h.login('later@example.com');
    expect(await count()).toBe(before);
    await h.req('POST', '/api/me/consent', { cookie });
    expect(await count()).toBe(before + 1);
    const list = await users();
    expect(list.find((u) => u.email === 'later@example.com')).toMatchObject({ status: 'pending', consentedAt: h.clock.now.toISOString() });
  });
});

describe('탈퇴', () => {
  it('탈퇴하면 즉시 로그인 API는 403 withdrawn, /api/me만 deleteAt과 함께 보인다', async () => {
    const u = await member('quit@example.com');
    const res = await h.req('POST', '/api/me/withdraw', { cookie: u.cookie });
    expect(res.status).toBe(200);
    const deleteAt = new Date(h.clock.now.getTime() + WITHDRAW_DAYS * DAY).toISOString();
    expect(((await res.json()) as MeResponse).user.deleteAt).toBe(deleteAt);
    expect((await me(u.cookie)).user.deleteAt).toBe(deleteAt);
    for (const [method, path] of [['GET', '/api/sessions'], ['GET', '/api/settings'], ['GET', '/api/stream'], ['GET', '/api/notify'],
      ['GET', '/api/me/storage'], ['GET', '/api/push/key'], ['POST', '/api/me/consent']] as const) {
      const r = await h.req(method, path, { cookie: u.cookie });
      expect([path, r.status]).toEqual([path, 403]);
      expect(await r.json()).toEqual({ error: 'withdrawn' });
    }
    // 다시 탈퇴해도 같은 삭제 예정 시각
    h.advance(1000);
    expect(((await (await h.req('POST', '/api/me/withdraw', { cookie: u.cookie })).json()) as MeResponse).user.deleteAt).toBe(deleteAt);
    // 로그아웃은 된다
    expect((await h.req('POST', '/auth/logout', { cookie: u.cookie })).status).toBe(200);
  });

  it('기기 토큰도 즉시 403 withdrawn(401 아님 — 플러그인은 큐에 남기고 기다린다), 탈퇴를 취소하면 그대로 이어진다', async () => {
    const u = await member('device-quit@example.com');
    await h.req('POST', '/api/me/withdraw', { cookie: u.cookie });
    const ing = await h.ingest(u.token, { ...h.batch([h.ev('q1', 'UserPromptSubmit', { prompt: 'x' })]), machine: MACHINE });
    expect(ing.status).toBe(403);
    expect(await ing.json()).toEqual({ error: 'withdrawn' });
    const ask = await h.req('POST', '/api/reply/ask', {
      token: u.token,
      body: { sessionId: 'q1', kind: 'permission', toolName: 'Bash', toolInput: {}, agentId: null, sessionAllow: null, at: h.clock.now.toISOString() },
    });
    expect(ask.status).toBe(403);
    expect((await h.req('POST', '/api/reply/inbox', { token: u.token, body: { sessionId: 'q1', waiterId: randomUUID() } })).status).toBe(403);
    // 연결 해제(권한을 줄이기만 하는 요청)는 할 수 있어야 하지만 여기서는 하지 않는다 — 토큰은 그대로 남아 있다
    const [m] = await db.sql<{ revoked_at: Date | null }[]>`SELECT revoked_at FROM machines WHERE id = ${u.machineId}`;
    expect(m!.revoked_at).toBeNull();

    const restored = await h.req('POST', '/api/me/restore', { cookie: u.cookie });
    expect(restored.status).toBe(200);
    expect(((await restored.json()) as MeResponse).user.deleteAt).toBeNull();
    expect((await h.ingest(u.token, { ...h.batch([h.ev('q1', 'UserPromptSubmit', { prompt: 'x' })]), machine: MACHINE })).status).toBe(200);
    expect((await h.req('GET', '/api/sessions', { cookie: u.cookie })).status).toBe(200);
  });

  it('탈퇴하면 붙잡혀 있던 글 대기자가 바로 풀린다', async () => {
    const u = await member('waiter-quit@example.com');
    await h.ingest(u.token, { ...h.batch([h.ev('w1', 'Stop', {})]), machine: MACHINE });
    const held = h.req('POST', '/api/reply/inbox', { token: u.token, body: { sessionId: 'w1', waiterId: randomUUID() } });
    for (let i = 0; i < 200 && h.deps.reply.size().inbox === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await h.req('POST', '/api/me/withdraw', { cookie: u.cookie });
    expect(await (await held).json()).toEqual({ status: 'gone' });
  });

  it('삭제 예정 시각이 지나면 탈퇴 취소는 409 expired, 매일 정리가 사용자와 모든 데이터를 지운다', async () => {
    const u = await member('gone@example.com');
    await h.ingest(u.token, { ...h.batch([h.ev('g1', 'UserPromptSubmit', { prompt: 'x' })]), machine: MACHINE, transcript: [{ sessionId: 'g1', seq: 0, lines: [h.line('지워질 대화')] }] });
    await h.req('POST', '/api/me/withdraw', { cookie: u.cookie });
    h.advance(WITHDRAW_DAYS * DAY - 1000);
    await runCleanup(h.deps);
    expect((await db.sql`SELECT 1 FROM users WHERE id = ${u.id}`).length).toBe(1);
    h.advance(2000);
    const restore = await h.req('POST', '/api/me/restore', { cookie: u.cookie });
    expect(restore.status).toBe(409);
    expect(await restore.json()).toEqual({ error: 'expired' });
    expect((await runCleanup(h.deps)).purgedUsers).toBeGreaterThanOrEqual(1);
    expect((await db.sql`SELECT 1 FROM users WHERE id = ${u.id}`).length).toBe(0);
    expect((await db.sql`SELECT 1 FROM machines WHERE id = ${u.machineId}`).length).toBe(0);
    expect((await db.sql`SELECT 1 FROM transcript_lines WHERE session_id = ${`${u.machineId}:g1`}`).length).toBe(0);
    expect((await h.ingest(u.token, h.batch([]))).status).toBe(401);
    expect((await h.req('GET', '/api/me', { cookie: u.cookie })).status).toBe(401);
    // 다시 로그인하면 새 가입(승인 대기·동의 전)
    const again = await h.login('gone@example.com');
    expect((await me(again)).user).toMatchObject({ status: 'pending', consentedAt: null, deleteAt: null });
    expect(await h.userId('gone@example.com')).not.toBe(u.id);
  });

  it('정리가 돌기 전이라도 삭제 예정 시각이 지난 뒤 로그인하면 옛 계정을 지우고 새로 가입한다', async () => {
    const u = await member('relogin@example.com');
    await h.req('POST', '/api/me/withdraw', { cookie: u.cookie });
    h.advance(WITHDRAW_DAYS * DAY + 1000);
    const cookie = await h.login('relogin@example.com');
    expect((await me(cookie)).user).toMatchObject({ status: 'pending', deleteAt: null });
    expect((await db.sql`SELECT 1 FROM machines WHERE id = ${u.machineId}`).length).toBe(0);
  });

  it('탈퇴 기간 안에 다시 로그인하면 탈퇴 상태 그대로(웹은 탈퇴 취소 화면을 보여 준다)', async () => {
    const u = await member('back@example.com');
    await h.req('POST', '/api/me/withdraw', { cookie: u.cookie });
    const cookie = await h.login('back@example.com');
    expect((await me(cookie)).user.deleteAt).not.toBeNull();
    expect((await h.req('GET', '/api/sessions', { cookie })).status).toBe(403);
    expect((await h.req('POST', '/api/me/restore', { cookie })).status).toBe(200);
    expect((await h.req('GET', '/api/sessions', { cookie })).status).toBe(200);
  });
});

describe('관리자: 사용자', () => {
  it('목록에 동의·삭제 예정·마지막 로그인·용량·컴퓨터 수·미리 추가 여부가 있다', async () => {
    const u = await member('listed@example.com');
    const row = (await users()).find((x) => x.id === u.id)!;
    expect(row).toMatchObject({
      email: 'listed@example.com', status: 'active', consentedAt: null, deleteAt: null,
      lastLoginAt: expect.any(String), quotaMb: DEFAULT_QUOTA_MB, machines: 1, invited: false, bytes: 0,
    });
  });

  it('미리 추가한 이메일은 첫 구글 로그인 때 승인 없이 쓴다(동의는 받는다), 이미 있으면 409', async () => {
    const res = await h.req('POST', '/api/admin/users', { cookie: adminCookie, body: { email: ' Invited@Example.com ', role: 'admin' } });
    expect(res.status).toBe(200);
    const view = (await res.json()) as AdminUserView;
    expect(view).toMatchObject({ email: 'invited@example.com', role: 'admin', status: 'active', invited: true, lastLoginAt: null, consentedAt: null });
    expect((await h.req('POST', '/api/admin/users', { cookie: adminCookie, body: { email: 'invited@example.com', role: 'user' } })).status).toBe(409);
    expect((await h.req('POST', '/api/admin/users', { cookie: adminCookie, body: { email: 'x', role: 'user' } })).status).toBe(400);

    const cookie = await h.login('invited@example.com');
    expect((await me(cookie)).user).toMatchObject({ status: 'active', role: 'admin', consentedAt: null });
    expect((await h.req('GET', '/api/sessions', { cookie })).status).toBe(200);
    expect((await users()).find((x) => x.email === 'invited@example.com')).toMatchObject({ invited: false, lastLoginAt: h.clock.now.toISOString() });
  });

  it('권한·용량 한도를 바꾸고, 자기 자신의 관리자 권한은 못 내린다', async () => {
    const u = await member('patch@example.com');
    const res = await h.req('PATCH', `/api/admin/users/${u.id}`, { cookie: adminCookie, body: { role: 'admin', quotaMb: 0 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: 'admin', quotaMb: 0 });
    expect((await h.req('PATCH', `/api/admin/users/${u.id}`, { cookie: adminCookie, body: { quotaMb: -1 } })).status).toBe(400);
    expect((await h.req('PATCH', `/api/admin/users/${adminId}`, { cookie: adminCookie, body: { role: 'user' } })).status).toBe(400);
    expect((await h.req('PATCH', `/api/admin/users/${adminId}`, { cookie: adminCookie, body: { quotaMb: 2048 } })).status).toBe(200);
    expect((await h.req('PATCH', '/api/admin/users/none', { cookie: adminCookie, body: { quotaMb: 1 } })).status).toBe(404);
  });

  it('탈퇴 취소와 즉시 삭제(자기 자신은 불가)', async () => {
    const u = await member('admin-restore@example.com');
    await h.req('POST', '/api/me/withdraw', { cookie: u.cookie });
    expect((await users()).find((x) => x.id === u.id)!.deleteAt).not.toBeNull();
    const res = await h.req('POST', `/api/admin/users/${u.id}/restore`, { cookie: adminCookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: u.id, deleteAt: null });
    expect((await h.req('POST', '/api/admin/users/none/restore', { cookie: adminCookie })).status).toBe(404);

    expect((await h.req('DELETE', `/api/admin/users/${adminId}`, { cookie: adminCookie })).status).toBe(400);
    expect((await h.req('DELETE', `/api/admin/users/${u.id}`, { cookie: adminCookie })).status).toBe(200);
    expect((await h.ingest(u.token, h.batch([]))).status).toBe(401);
    expect((await h.req('DELETE', `/api/admin/users/${u.id}`, { cookie: adminCookie })).status).toBe(404);
  });

  it('관리자가 아니면 403, 로그인하지 않으면 401', async () => {
    const u = await member('plain-user@example.com');
    for (const [method, path] of [['GET', '/api/admin/users'], ['POST', '/api/admin/users'], ['PATCH', `/api/admin/users/${u.id}`],
      ['POST', `/api/admin/users/${u.id}/restore`], ['DELETE', `/api/admin/users/${adminId}`], ['GET', '/api/admin/machines'],
      ['PATCH', `/api/admin/machines/${u.machineId}`], ['DELETE', `/api/admin/machines/${u.machineId}`], ['GET', '/api/admin/storage']] as const) {
      const body = method === 'GET' ? undefined : {};
      expect([path, (await h.req(method, path, { cookie: u.cookie, body })).status]).toEqual([path, 403]);
      expect([path, (await h.req(method, path, { body })).status]).toEqual([path, 401]);
    }
  });
});

describe('저장 용량', () => {
  const sid = (u: { machineId: string }, name: string) => `${u.machineId}:${name}`;
  /** 대화 줄을 DB에 바로 넣는다(크기 n바이트의 글, at은 시작 시각부터 1분 간격). */
  async function lines(sessionId: string, from: number, count: number, size: number, at: Date) {
    await db.sql`
      INSERT INTO transcript_lines (session_id, seq, role, at, text)
      SELECT ${sessionId}, ${from} + g, 'assistant', ${at}::timestamptz + make_interval(mins => g), repeat('x', ${size})
      FROM generate_series(0, ${count - 1}) AS g`;
  }

  it('내 사용량은 대화 본문·도구 입력 길이 합 + 한도 기록 수 × 64, 한도·정리 시각과 함께', async () => {
    const u = await member('bytes@example.com');
    await h.ingest(u.token, {
      ...h.batch([h.ev('b1', 'UserPromptSubmit', { prompt: 'x' })]), machine: MACHINE,
      transcript: [{ sessionId: 'b1', seq: 0, lines: [h.line('가나다'), h.line('abc', { role: 'tool', toolName: 'Bash', toolInput: { command: 'ls' } })] }],
      limits: { account: 'c@example.com', fiveHourPct: 1, fiveHourResetsAt: null, sevenDayPct: 1, sevenDayResetsAt: null, at: h.clock.now.toISOString() },
    });
    const res = await h.req('GET', '/api/me/storage', { cookie: u.cookie });
    expect(res.status).toBe(200);
    // '가나다' 9바이트 + 'abc' 3바이트 + '{"command": "ls"}' 17바이트 + 한도 1줄 64
    expect(await res.json()).toEqual<StorageMe>({ bytes: 9 + 3 + 17 + 64, quotaMb: DEFAULT_QUOTA_MB, trimmedAt: null });
  });

  it('한도를 넘으면 오래된 줄부터 넘친 만큼만 지우고, 최근 24시간 줄은 남기며, 알린다', async () => {
    const u = await member('trim@example.com');
    await h.ingest(u.token, { ...h.batch([h.ev('t1', 'UserPromptSubmit', { prompt: 'x' })]), machine: MACHINE });
    await h.req('PATCH', `/api/admin/users/${u.id}`, { cookie: adminCookie, body: { quotaMb: 1 } });
    await h.req('POST', '/api/push/subscribe', { cookie: u.cookie, body: { endpoint: 'https://push.example.test/trim', keys: { p256dh: 'k', auth: 'a' } } });
    // 오래된 줄 5개(3일 전) + 최근 줄 2개(1시간 전), 줄마다 300,000바이트 → 2,100,000바이트, 한도 1,048,576바이트
    await lines(sid(u, 't1'), 0, 5, 300_000, new Date(h.clock.now.getTime() - 3 * DAY));
    await lines(sid(u, 't1'), 100, 2, 300_000, new Date(h.clock.now.getTime() - HOUR));
    fp.clear();
    const result = await runCleanup(h.deps);
    expect(result.trimmedLines).toBe(4);
    const left = await db.sql<{ seq: number }[]>`SELECT seq FROM transcript_lines WHERE session_id = ${sid(u, 't1')} ORDER BY seq`;
    expect(left.map((r) => r.seq)).toEqual([4, 100, 101]);
    const storage = (await (await h.req('GET', '/api/me/storage', { cookie: u.cookie })).json()) as StorageMe;
    expect(storage.bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(storage).toMatchObject({ quotaMb: 1, trimmedAt: h.clock.now.toISOString() });
    await h.deps.push.idle();
    expect(fp.take('https://push.example.test/trim').map((m) => m.payload)).toEqual([{
      title: '💾 저장 용량 한도', body: expect.stringContaining('대화 4줄'), url: '/', tag: 'trim',
    }]);
  });

  it('최근 24시간 줄만으로 한도를 넘으면 아무것도 지우지 않는다', async () => {
    const u = await member('recent@example.com');
    await h.ingest(u.token, { ...h.batch([h.ev('r1', 'UserPromptSubmit', { prompt: 'x' })]), machine: MACHINE });
    await h.req('PATCH', `/api/admin/users/${u.id}`, { cookie: adminCookie, body: { quotaMb: 1 } });
    await lines(sid(u, 'r1'), 0, 5, 300_000, new Date(h.clock.now.getTime() - 2 * HOUR));
    await runCleanup(h.deps);
    expect((await db.sql`SELECT 1 FROM transcript_lines WHERE session_id = ${sid(u, 'r1')}`).length).toBe(5);
    const [row] = await db.sql<{ trimmed_at: Date | null }[]>`SELECT trimmed_at FROM users WHERE id = ${u.id}`;
    expect(row!.trimmed_at).toBeNull();
  });

  it('한도 0(무제한)이면 아무리 커도 지우지 않는다', async () => {
    const u = await member('unlimited@example.com');
    await h.ingest(u.token, { ...h.batch([h.ev('u1', 'UserPromptSubmit', { prompt: 'x' })]), machine: MACHINE });
    await h.req('PATCH', `/api/admin/users/${u.id}`, { cookie: adminCookie, body: { quotaMb: 0 } });
    await lines(sid(u, 'u1'), 0, 8, 300_000, new Date(h.clock.now.getTime() - 3 * DAY));
    await runCleanup(h.deps);
    expect((await db.sql`SELECT 1 FROM transcript_lines WHERE session_id = ${sid(u, 'u1')}`).length).toBe(8);
  });

  it('관리자 저장 용량: DB 전체·대화·사용량·기타, 디스크 남은 공간, 사용자별 사용량(큰 순)', async () => {
    const res = await h.req('GET', '/api/admin/storage', { cookie: adminCookie });
    expect(res.status).toBe(200);
    const view = (await res.json()) as AdminStorageView;
    expect(view.totalBytes).toBeGreaterThan(0);
    expect(view.chatBytes).toBeGreaterThan(0);
    expect(view.usageBytes).toBeGreaterThan(0);
    expect(view.otherBytes).toBe(Math.max(0, view.totalBytes - view.chatBytes - view.usageBytes));
    expect(view.diskFreeBytes).toBe(123_456_789);
    expect(view.users[0]).toMatchObject({ email: 'unlimited@example.com', quotaMb: 0, bytes: 8 * 300_000 });
    const bytes = view.users.map((u) => u.bytes);
    expect([...bytes].sort((x, y) => y - x)).toEqual(bytes);
  });
});

describe('보관 기간 0 = 지우지 않음', () => {
  it('설정에 0을 넣을 수 있고, 그 사용자의 오래된 대화·한도는 정리에서 남는다', async () => {
    const keep = await member('keep@example.com');
    const normal = await member('normal@example.com');
    const at = new Date(h.clock.now.getTime() - 400 * DAY).toISOString();
    for (const u of [keep, normal]) {
      await h.ingest(u.token, {
        ...h.batch([h.ev('k1', 'UserPromptSubmit', { prompt: 'x' })]), machine: MACHINE,
        transcript: [{ sessionId: 'k1', seq: 0, lines: [h.line('아주 오래된 줄', { at })] }],
        limits: { account: 'k@example.com', fiveHourPct: 1, fiveHourResetsAt: null, sevenDayPct: 1, sevenDayResetsAt: null, at },
      });
    }
    const put = await h.req('PUT', '/api/settings', { cookie: keep.cookie, body: { keepChatDays: 0, keepUsageDays: 0 } });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ keepChatDays: 0, keepUsageDays: 0 });
    expect((await h.req('PUT', '/api/settings', { cookie: keep.cookie, body: { keepChatDays: -1 } })).status).toBe(400);

    await runCleanup(h.deps);
    const count = async (u: { id: string; machineId: string }) => ({
      lines: (await db.sql`SELECT 1 FROM transcript_lines WHERE session_id = ${`${u.machineId}:k1`}`).length,
      limits: (await db.sql`SELECT 1 FROM limits WHERE user_id = ${u.id}`).length,
    });
    expect(await count(keep)).toEqual({ lines: 1, limits: 1 });
    expect(await count(normal)).toEqual({ lines: 0, limits: 0 });
  });
});
