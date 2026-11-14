// 세션 삭제: 종료·연락 끊김 세션을 소유자가 지운다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DashboardSnapshot, IngestBatch } from '@c-monitor/shared';
import { ADMIN, MIN, makeHarness, makeTestDb, type TestDb } from './helpers';

let db: TestDb;
let h: ReturnType<typeof makeHarness>;
let admin: string;
let a: { cookie: string; id: string; token: string; machineId: string };
let b: { cookie: string; id: string };

beforeAll(async () => {
  db = await makeTestDb();
  h = makeHarness(db);
  admin = await h.login(ADMIN);
  const ua = await h.activeUser('a@example.com');
  b = await h.activeUser('b@example.com');
  a = { ...ua, ...(await h.connect(ua.cookie, 'pc-a')) };
});
afterAll(async () => { await db.drop(); });

const sid = (name: string) => `${a.machineId}:${name}`;
const del = (name: string, cookie?: string) =>
  h.req('DELETE', `/api/sessions/${encodeURIComponent(sid(name))}`, cookie ? { cookie } : {});
const exists = async (name: string) => (await db.sql`SELECT 1 FROM sessions WHERE id = ${sid(name)}`).length === 1;
const lineCount = async (name: string) =>
  (await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM transcript_lines WHERE session_id = ${sid(name)}`)[0]!.n;
const listed = async (q = '') =>
  ((await (await h.req('GET', `/api/sessions${q}`, { cookie: a.cookie })).json()) as DashboardSnapshot).sessions.map((s) => s.id);

/** 대화 두 줄이 있는 종료된 세션을 만든다. 보낸 묶음들을 돌려준다(다시 보내기 시험용). */
async function endedSession(name: string): Promise<IngestBatch[]> {
  const first = h.batch([h.ev(name, 'UserPromptSubmit', { prompt: '질문' })], {
    transcript: [{ sessionId: name, seq: 0, lines: [h.line('질문', { role: 'user' }), h.line('답변')] }],
  });
  const second = h.batch([h.ev(name, 'SessionEnd', { reason: 'exit' })]);
  expect((await h.ingest(a.token, first)).status).toBe(200);
  expect((await h.ingest(a.token, second)).status).toBe(200);
  return [first, second];
}

describe('세션 삭제 (DELETE /api/sessions/:id)', () => {
  it('종료된 세션을 지우면 목록·대화에서 사라지고, 소유자에게만 removed가 간다', async () => {
    await endedSession('gone');
    await db.sql`INSERT INTO shares (id, session_id, owner_id, target_user_id) VALUES ('share-1', ${sid('gone')}, ${a.id}, ${b.id})`;
    expect(await listed()).toContain(sid('gone'));
    expect(await lineCount('gone')).toBe(2);
    h.published.length = 0;

    const res = await del('gone', a.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(await listed()).not.toContain(sid('gone'));
    expect(await listed('?history=1')).not.toContain(sid('gone'));
    expect((await h.req('GET', `/api/sessions/${encodeURIComponent(sid('gone'))}/log`, { cookie: a.cookie })).status).toBe(404);
    expect(await exists('gone')).toBe(false);
    expect(await lineCount('gone')).toBe(0);
    expect((await db.sql`SELECT 1 FROM shares WHERE id = 'share-1'`).length).toBe(0);

    expect(h.published).toEqual([{ userId: a.id, msg: { type: 'removed', sessionIds: [sid('gone')] } }]);

    // 이미 지운 것을 다시 지우면 404
    expect((await del('gone', a.cookie)).status).toBe(404);
  });

  it('연락이 끊긴(lost) 세션도 지울 수 있다', async () => {
    await h.ingest(a.token, h.batch([h.ev('lost-1', 'UserPromptSubmit', { prompt: 'x' })]));
    await db.sql`UPDATE sessions SET status = 'lost' WHERE id = ${sid('lost-1')}`;
    expect((await del('lost-1', a.cookie)).status).toBe(200);
    expect(await exists('lost-1')).toBe(false);
  });

  it('작업 중·기다림·끝남 상태의 세션은 409 session_active', async () => {
    await h.ingest(a.token, h.batch([h.ev('busy', 'UserPromptSubmit', { prompt: 'x' })], {
      transcript: [{ sessionId: 'busy', seq: 0, lines: [h.line('진행 중')] }],
    }));
    h.published.length = 0;
    for (const status of ['run', 'wait', 'done', 'limit']) {
      await db.sql`UPDATE sessions SET status = ${status} WHERE id = ${sid('busy')}`;
      const res = await del('busy', a.cookie);
      expect([status, res.status]).toEqual([status, 409]);
      expect(await res.json()).toEqual({ error: 'session_active' });
    }
    expect(await exists('busy')).toBe(true);
    expect(await lineCount('busy')).toBe(1);
    expect(h.published).toEqual([]);
  });

  it('남의 세션·없는 세션은 404(관리자도 남의 것은 못 지운다), 로그인하지 않으면 401', async () => {
    await endedSession('keep');
    expect((await del('keep', b.cookie)).status).toBe(404);
    expect((await del('keep', admin)).status).toBe(404);
    expect((await del('keep')).status).toBe(401);
    expect((await h.req('DELETE', '/api/sessions/none', { cookie: a.cookie })).status).toBe(404);
    expect(await exists('keep')).toBe(true);
    expect(await lineCount('keep')).toBe(2);
  });

  it('지운 뒤 이미 받은 묶음을 다시 보내도(멱등 중복) 세션이 되살아나지 않는다', async () => {
    const sent = await endedSession('dup');
    expect((await del('dup', a.cookie)).status).toBe(200);
    h.published.length = 0;

    for (const batch of sent) {
      const res = await h.ingest(a.token, batch);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ accepted: 0 });
    }
    expect(await exists('dup')).toBe(false);
    expect(await lineCount('dup')).toBe(0);
    expect(h.published.filter((p) => p.msg.type === 'session' || p.msg.type === 'log')).toEqual([]);
  });

  it('지운 뒤 같은 세션 id로 새 이벤트가 오면 새 세션으로 다시 만들어진다', async () => {
    await endedSession('back');
    expect((await del('back', a.cookie)).status).toBe(200);
    h.advance(5 * MIN);
    const startedAt = h.clock.now.toISOString();

    const res = await h.ingest(a.token, h.batch([h.ev('back', 'UserPromptSubmit', { prompt: '다시 시작' })], {
      transcript: [{ sessionId: 'back', seq: 2, lines: [h.line('다시 시작', { role: 'user' })] }],
    }));
    expect(await res.json()).toEqual({ accepted: 1 });

    const [row] = await db.sql<{ status: string; started_at: Date; ended_at: Date | null }[]>`
      SELECT status, started_at, ended_at FROM sessions WHERE id = ${sid('back')}`;
    expect(row).toMatchObject({ status: 'run', ended_at: null });
    expect(row!.started_at.toISOString()).toBe(startedAt); // 예전 세션의 흔적이 아니라 새로 시작한 것
    expect(await lineCount('back')).toBe(1); // 지운 대화는 돌아오지 않는다
    expect(await listed()).toContain(sid('back'));
  });
});
