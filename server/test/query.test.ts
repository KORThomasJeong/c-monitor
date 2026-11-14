import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountView, DashboardSnapshot, LogResponse, SettingsView } from '@c-monitor/shared';
import { ADMIN, HOUR, MIN, makeHarness, makeTestDb, type TestDb } from './helpers';

let db: TestDb;
let h: ReturnType<typeof makeHarness>;
let admin: string;
let a: { cookie: string; id: string; token: string; machineId: string };
let b: { cookie: string; id: string; token: string; machineId: string };
let aSession: string;

beforeAll(async () => {
  db = await makeTestDb();
  h = makeHarness(db);
  admin = await h.login(ADMIN);
  const ua = await h.activeUser('a@example.com');
  const ub = await h.activeUser('b@example.com');
  a = { ...ua, ...(await h.connect(ua.cookie, 'pc-a')) };
  b = { ...ub, ...(await h.connect(ub.cookie, 'pc-b')) };
  await h.ingest(a.token, h.batch([h.ev('s1', 'UserPromptSubmit', { prompt: 'A의 질문' }, { account: 'a-claude@example.com' })], {
    transcript: [{ sessionId: 's1', seq: 0, lines: [h.line('A의 대화 0'), h.line('A의 대화 1')] }],
  }));
  await h.ingest(a.token, h.batch([h.ev('s1', 'Notification', { notification_type: 'permission_prompt', message: 'm' })]));
  await h.ingest(b.token, h.batch([h.ev('s1', 'UserPromptSubmit', { prompt: 'B의 질문' })]));
  aSession = encodeURIComponent(`${a.machineId}:s1`);
});
afterAll(async () => { await db.drop(); });

const snap = async (cookie: string, q = '') =>
  (await (await h.req('GET', `/api/sessions${q}`, { cookie })).json()) as DashboardSnapshot;

describe('남의 데이터 격리', () => {
  it('B 로그인으로 A의 세션·대화·seen은 404', async () => {
    expect((await h.req('GET', `/api/sessions/${aSession}/log`, { cookie: b.cookie })).status).toBe(404);
    expect((await h.req('POST', `/api/sessions/${aSession}/seen`, { cookie: b.cookie })).status).toBe(404);
    const [row] = await db.sql<{ seen: boolean }[]>`SELECT seen FROM sessions WHERE id = ${`${a.machineId}:s1`}`;
    expect(row!.seen).toBe(false);
    expect((await h.req('GET', '/api/sessions/none/log', { cookie: b.cookie })).status).toBe(404);
  });

  it('B의 목록에는 B의 것만 있다', async () => {
    const s = await snap(b.cookie);
    expect(s.sessions.map((x) => x.id)).toEqual([`${b.machineId}:s1`]);
    expect(s.machines.map((m) => m.id)).toEqual([b.machineId]);
    expect(s.accounts).toEqual([]);
    expect(JSON.stringify(s)).not.toContain('A의');
  });

  it('일반 사용자가 ?user=로 남을 지정하면 403', async () => {
    expect((await h.req('GET', `/api/sessions?user=${a.id}`, { cookie: b.cookie })).status).toBe(403);
    // 자기 자신 지정은 된다
    expect((await h.req('GET', `/api/sessions?user=${b.id}`, { cookie: b.cookie })).status).toBe(200);
  });

  it('관리자는 다른 사용자의 목록과 대화를 볼 수 있다', async () => {
    const s = await snap(admin, `?user=${a.id}`);
    expect(s.sessions.map((x) => x.id)).toEqual([`${a.machineId}:s1`]);
    expect(s.machines.map((m) => m.id)).toEqual([a.machineId]);
    expect(s.accounts.map((x) => x.email)).toEqual(['a-claude@example.com']);
    const log = (await (await h.req('GET', `/api/sessions/${aSession}/log`, { cookie: admin })).json()) as LogResponse;
    expect(log.lines.map((l) => l.text)).toEqual(['A의 대화 0', 'A의 대화 1']);
    // 관리자 자신의 기본 목록에는 섞이지 않는다
    expect((await snap(admin)).sessions).toEqual([]);
    // 관리자라도 남의 세션을 '봤음'으로 바꾸지는 않는다
    expect((await h.req('POST', `/api/sessions/${aSession}/seen`, { cookie: admin })).status).toBe(404);
  });

  it('남의 계정 별칭은 바꿀 수 없다', async () => {
    const res = await h.req('PATCH', `/api/accounts/${encodeURIComponent('a-claude@example.com')}`, { cookie: b.cookie, body: { alias: 'x' } });
    expect(res.status).toBe(404);
  });
});

describe('조회', () => {
  it('계정 별칭·숨기기를 바꾸고 스트림으로 알린다', async () => {
    h.published.length = 0;
    const res = await h.req('PATCH', `/api/accounts/${encodeURIComponent('a-claude@example.com')}`, { cookie: a.cookie, body: { alias: '회사', hidden: true } });
    expect(res.status).toBe(200);
    expect((await res.json()) as AccountView).toMatchObject({ email: 'a-claude@example.com', alias: '회사', hidden: true });
    expect((await snap(a.cookie)).accounts[0]).toMatchObject({ alias: '회사', hidden: true });
    expect(h.published).toHaveLength(1);
    expect(h.published[0]).toMatchObject({ userId: a.id, msg: { type: 'limits', account: { alias: '회사' } } });
    // 일부만 보내면 나머지는 그대로
    await h.req('PATCH', `/api/accounts/${encodeURIComponent('a-claude@example.com')}`, { cookie: a.cookie, body: { hidden: false } });
    expect((await snap(a.cookie)).accounts[0]).toMatchObject({ alias: '회사', hidden: false });
    const bad = await h.req('PATCH', `/api/accounts/${encodeURIComponent('a-claude@example.com')}`, { cookie: a.cookie, body: { hidden: 'yes' } });
    expect(bad.status).toBe(400);
  });

  it('설정은 기본값으로 시작하고 바꿀 수 있다', async () => {
    const get = (await (await h.req('GET', '/api/settings', { cookie: a.cookie })).json()) as SettingsView;
    expect(get).toEqual({ lostMinutes: 10, endHours: 24, keepChatDays: 30, keepUsageDays: 90 });
    const put = await h.req('PUT', '/api/settings', { cookie: a.cookie, body: { lostMinutes: 5, endHours: 1 } });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ lostMinutes: 5, endHours: 1, keepChatDays: 30, keepUsageDays: 90 });
    expect((await (await h.req('GET', '/api/settings', { cookie: b.cookie })).json()) as SettingsView).toMatchObject({ lostMinutes: 10 });
    expect((await h.req('PUT', '/api/settings', { cookie: a.cookie, body: { lostMinutes: 0 } })).status).toBe(400);
    expect((await h.req('PUT', '/api/settings', { cookie: a.cookie, body: { endHours: 'x' } })).status).toBe(400);
  });

  it('종료된 세션은 end_hours가 지나면 기본 목록에서 빠지고 history=1에는 남는다', async () => {
    await h.ingest(a.token, h.batch([h.ev('ended', 'SessionEnd', { reason: 'exit' })]));
    const id = `${a.machineId}:ended`;
    expect((await snap(a.cookie)).sessions.map((s) => s.id)).toContain(id);
    h.advance(1 * HOUR + MIN); // 위에서 endHours를 1로 바꿨다
    expect((await snap(a.cookie)).sessions.map((s) => s.id)).not.toContain(id);
    expect((await snap(a.cookie, '?history=1')).sessions.map((s) => s.id)).toContain(id);
    // 끝나지 않은 세션은 오래돼도 남는다
    expect((await snap(a.cookie)).sessions.map((s) => s.id)).toContain(`${a.machineId}:s1`);
  });

  it('기기 online은 마지막 접속 10분 이내', async () => {
    await h.ingest(b.token, h.batch([]));
    expect((await snap(b.cookie)).machines[0]!.online).toBe(true);
    h.advance(11 * MIN);
    const m = (await snap(b.cookie)).machines[0]!;
    expect(m.online).toBe(false);
    expect(m.lastSeenAt).not.toBeNull();
  });

  it('기기를 폐기하면 기본 목록에서 기기와 그 세션이 빠지고 스냅샷이 다시 나간다', async () => {
    const c = await h.activeUser('c@example.com');
    const dev = await h.connect(c.cookie, 'pc-c');
    await h.ingest(dev.token, h.batch([h.ev('s1', 'UserPromptSubmit', { prompt: 'x' })]));
    h.published.length = 0;
    expect((await h.req('DELETE', `/api/machines/${dev.machineId}`, { cookie: c.cookie })).status).toBe(200);
    const s = await snap(c.cookie);
    expect(s.machines).toEqual([]);
    expect(s.sessions).toEqual([]);
    expect(h.published.at(-1)).toMatchObject({ userId: c.id, msg: { type: 'snapshot', machines: [], sessions: [] } });
    const hist = await snap(c.cookie, '?history=1');
    expect(hist.sessions).toHaveLength(1);
    expect(hist.machines).toHaveLength(1);
  });
});

describe('정적 웹 서빙', () => {
  it('web/dist가 있으면 파일을 주고, 그 밖의 경로는 index.html(SPA)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-web-'));
    try {
      mkdirSync(join(dir, 'assets'));
      writeFileSync(join(dir, 'index.html'), '<html>앱</html>');
      writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
      const hs = makeHarness(db, { webDist: dir });
      const js = await hs.req('GET', '/assets/app.js');
      expect(js.status).toBe(200);
      expect(js.headers.get('content-type')).toMatch(/javascript/);
      expect(await js.text()).toBe('console.log(1)');
      const spa = await hs.req('GET', '/connect?code=ABCD-EFGH');
      expect(spa.status).toBe(200);
      expect(spa.headers.get('content-type')).toMatch(/text\/html/);
      expect(await spa.text()).toBe('<html>앱</html>');
      // API·auth 경로는 index.html로 떨어지지 않는다
      expect((await hs.req('GET', '/api/nope')).status).toBe(404);
      expect((await hs.req('GET', '/auth/nope')).status).toBe(404);
      // 폴더 밖으로 나갈 수 없다
      const up = await hs.req('GET', '/..%2f..%2fpackage.json');
      expect(await up.text()).toBe('<html>앱</html>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('web/dist가 없으면 404', async () => {
    expect((await h.req('GET', '/')).status).toBe(404);
  });
});
