import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DashboardSnapshot } from '@c-monitor/shared';
import { runCleanup } from '../src/jobs/cleanup';
import { runLostCheck } from '../src/jobs/lost';
import { DAY, MIN, makeHarness, makeTestDb, type TestDb } from './helpers';

let db: TestDb;
let h: ReturnType<typeof makeHarness>;
let a: { cookie: string; id: string; token: string; machineId: string };
let b: { cookie: string; id: string; token: string; machineId: string };

beforeAll(async () => {
  db = await makeTestDb();
  h = makeHarness(db);
  const ua = await h.activeUser('a@example.com');
  const ub = await h.activeUser('b@example.com');
  a = { ...ua, ...(await h.connect(ua.cookie, 'pc-a')) };
  b = { ...ub, ...(await h.connect(ub.cookie, 'pc-b')) };
});
afterAll(async () => { await db.drop(); });

const statuses = async (cookie: string) => {
  const s = (await (await h.req('GET', '/api/sessions?history=1', { cookie })).json()) as DashboardSnapshot;
  return Object.fromEntries(s.sessions.map((x) => [x.id.split(':')[1], x.status]));
};

describe('끊김 판정', () => {
  it('기준 시간이 지난 run만 lost로 바꾸고 소유자에게 publish한다', async () => {
    await h.ingest(a.token, h.batch([
      h.ev('old-run', 'UserPromptSubmit', { prompt: 'x' }),
      h.ev('old-wait', 'Notification', { notification_type: 'permission_prompt', message: 'm' }),
      h.ev('old-done', 'Stop', {}),
    ]));
    // B는 끊김 기준을 30분으로 늘렸다
    await h.req('PUT', '/api/settings', { cookie: b.cookie, body: { lostMinutes: 30 } });
    await h.ingest(b.token, h.batch([h.ev('b-run', 'UserPromptSubmit', { prompt: 'x' })]));

    h.advance(6 * MIN);
    await h.ingest(a.token, h.batch([h.ev('new-run', 'UserPromptSubmit', { prompt: 'x' })]));
    h.advance(5 * MIN); // old-*는 11분, new-run은 5분 지남

    h.published.length = 0;
    expect(await runLostCheck(h.deps)).toBe(1);
    expect(await statuses(a.cookie)).toEqual({ 'old-run': 'lost', 'old-wait': 'wait', 'old-done': 'done', 'new-run': 'run' });
    expect(await statuses(b.cookie)).toEqual({ 'b-run': 'run' });
    expect(h.published).toHaveLength(1);
    expect(h.published[0]).toMatchObject({ userId: a.id, msg: { type: 'session', session: { id: `${a.machineId}:old-run`, status: 'lost' } } });

    // 다시 돌려도 더 바뀌지 않는다
    expect(await runLostCheck(h.deps)).toBe(0);

    // B도 30분이 지나면 끊김
    h.advance(20 * MIN);
    await runLostCheck(h.deps);
    expect((await statuses(b.cookie))['b-run']).toBe('lost');

    // 끊긴 세션에 이벤트가 다시 오면 살아난다
    await h.ingest(a.token, h.batch([h.ev('old-run', 'PostToolUse', {})]));
    expect((await statuses(a.cookie))['old-run']).toBe('run');
  });
});

describe('보관 정리', () => {
  it('30일 지난 대화와 90일 지난 한도를 지운다(사용자별 설정)', async () => {
    const limit = (pct: number) => ({
      account: 'acc@example.com', fiveHourPct: pct, fiveHourResetsAt: null, sevenDayPct: pct, sevenDayResetsAt: null,
      at: h.clock.now.toISOString(),
    });
    // 100일 전
    await h.ingest(a.token, h.batch([h.ev('chat', 'UserPromptSubmit', { prompt: 'x' })], {
      transcript: [{ sessionId: 'chat', seq: 0, lines: [h.line('아주 오래된 줄')] }], limits: limit(1),
    }));
    h.advance(60 * DAY); // 40일 전
    await h.ingest(a.token, h.batch([], {
      transcript: [{ sessionId: 'chat', seq: 1, lines: [h.line('오래된 줄')] }], limits: limit(2),
    }));
    await h.ingest(b.token, h.batch([h.ev('chat', 'UserPromptSubmit', { prompt: 'x' })], {
      transcript: [{ sessionId: 'chat', seq: 0, lines: [h.line('B의 오래된 줄')] }],
    }));
    h.advance(30 * DAY); // 10일 전
    await h.ingest(a.token, h.batch([], {
      transcript: [{ sessionId: 'chat', seq: 2, lines: [h.line('새 줄')] }], limits: limit(3),
    }));
    h.advance(10 * DAY);

    // B는 대화를 60일 보관한다(시계를 100일 넘겼으니 로그인 쿠키는 만료됐다 → 다시 로그인)
    expect((await h.req('GET', '/api/me', { cookie: b.cookie })).status).toBe(401);
    const bCookie = await h.login('b@example.com');
    expect((await h.req('PUT', '/api/settings', { cookie: bCookie, body: { keepChatDays: 60 } })).status).toBe(200);

    const result = await runCleanup(h.deps);
    expect(result).toMatchObject({ lines: 2, limits: 1 });

    const aLines = await db.sql<{ text: string }[]>`
      SELECT text FROM transcript_lines WHERE session_id = ${`${a.machineId}:chat`} ORDER BY seq`;
    expect(aLines.map((l) => l.text)).toEqual(['새 줄']);
    const bLines = await db.sql<{ text: string }[]>`
      SELECT text FROM transcript_lines WHERE session_id = ${`${b.machineId}:chat`}`;
    expect(bLines.map((l) => l.text)).toEqual(['B의 오래된 줄']);
    const lim = await db.sql<{ five_pct: number }[]>`SELECT five_pct FROM limits WHERE user_id = ${a.id} ORDER BY at`;
    expect(lim.map((l) => l.five_pct)).toEqual([2, 3]);
  });

  it('만료된 로그인 세션·기기 연결 요청도 치운다', async () => {
    await h.req('POST', '/api/device/start', { body: { machineName: 'x', os: 'y', pluginVersion: 'z' } });
    await h.login('a@example.com');
    const before = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM web_sessions`;
    expect(before[0]!.n).toBeGreaterThan(0);
    h.advance(31 * DAY);
    await runCleanup(h.deps);
    expect((await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM web_sessions`)[0]!.n).toBe(0);
    expect((await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM device_requests WHERE approved_user_id IS NULL`)[0]!.n).toBe(0);
  });
});
