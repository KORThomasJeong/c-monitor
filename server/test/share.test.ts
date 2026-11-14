// 공유(3차): 링크 공유(로그인 없이 보기만)와 사람 지정 공유. 공개 링크로 컴퓨터·다른 세션·답장 경로가 새지 않는지(Review Focus 1),
// 탈퇴·정지·취소·만료·세션 삭제 때 바로 막히는지(Review Focus 2)를 본다.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  DashboardSnapshot, LogResponse, PublicSessionView, PublicStreamMessage, ShareView, StreamMessage,
} from '@c-monitor/shared';
import { ADMIN, MIN, makeHarness, makeTestDb, sseReader, type TestDb } from './helpers';

let db: TestDb;
let h: ReturnType<typeof makeHarness>;
let adminCookie: string;
let a: { cookie: string; id: string; token: string; machineId: string };
let b: { cookie: string; id: string; token: string; machineId: string };
let c: { cookie: string; id: string };

const MACHINE = { name: 'secret-pc-name', os: 'win32', pluginVersion: '0.2.0' };
const sid = (name: string) => `${a.machineId}:${name}`;
const enc = (name: string) => encodeURIComponent(sid(name));
const send = (events: Parameters<typeof h.batch>[0], extra: Parameters<typeof h.batch>[1] = {}) =>
  h.ingest(a.token, { ...h.batch(events, extra), machine: MACHINE });

beforeAll(async () => {
  db = await makeTestDb();
  h = makeHarness(db, { pingMs: 40, replyPollMs: 200 });
  adminCookie = await h.login(ADMIN);
  const ua = await h.activeUser('owner@example.com');
  const ub = await h.activeUser('friend@example.com');
  c = await h.activeUser('stranger@example.com');
  a = { ...ua, ...(await h.connect(ua.cookie, 'pc-a')) };
  b = { ...ub, ...(await h.connect(ub.cookie, 'pc-b')) };
  // 공유할 세션 s1(원격 제어 주소·계정 포함)과 공유하지 않을 세션 s2.
  await send([h.ev('s1', 'UserPromptSubmit', { prompt: '공유할 질문' }, {
    cwd: 'C:\\Users\\owner\\work\\shared-proj', account: 'owner-claude@example.com',
    remoteUrl: 'https://claude.ai/code/abcdef123',
  })], { transcript: [{ sessionId: 's1', seq: 0, lines: [h.line('공유된 대화 0'), h.line('공유된 대화 1')] }] });
  await send([h.ev('s2', 'UserPromptSubmit', { prompt: '비밀 질문' }, { cwd: 'C:\\work\\private' })], {
    transcript: [{ sessionId: 's2', seq: 0, lines: [h.line('비밀 대화')] }],
  });
  await h.ingest(b.token, { ...h.batch([h.ev('bs', 'UserPromptSubmit', { prompt: 'B의 질문' })]), machine: { ...MACHINE, name: 'pc-b' } });
});
afterAll(async () => { await db.drop(); });

async function createShare(body: unknown, cookie = a.cookie, name = 's1'): Promise<Response> {
  return h.req('POST', `/api/sessions/${enc(name)}/shares`, { cookie, body });
}
async function linkShare(expiresIn: '1h' | '1d' | '7d' | 'never' = 'never', name = 's1'): Promise<{ share: ShareView; token: string }> {
  const res = await createShare({ kind: 'link', expiresIn }, a.cookie, name);
  expect(res.status).toBe(200);
  const share = (await res.json()) as ShareView;
  return { share, token: share.url!.split('/s/')[1]! };
}
const pub = (token: string, rest = '') => h.req('GET', `/api/public/s/${token}${rest}`);
const snap = async (cookie: string) => (await (await h.req('GET', '/api/sessions', { cookie })).json()) as DashboardSnapshot;

/** 스트림이 끝날 때까지 메시지를 읽어 버린다(끝나면 true, 시간이 다 되면 false). */
async function streamEnds(r: ReturnType<typeof sseReader>, ms = 2_000): Promise<boolean> {
  const done = (async () => {
    try {
      for (;;) await r.next();
    } catch {
      return true;
    }
  })();
  return Promise.race([done, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
}

describe('링크 공유 만들기·목록·취소', () => {
  it('소유자가 링크를 만들면 주소는 한 번만 내려주고, DB에는 토큰의 해시만 남는다', async () => {
    const { share, token } = await linkShare('1h');
    expect(share).toMatchObject({ kind: 'link', email: null });
    expect(share.url).toMatch(/^https:\/\/cs\.test\/s\/[A-Za-z0-9_-]{43}$/);
    expect(share.expiresAt).toBe(new Date(h.clock.now.getTime() + 60 * MIN).toISOString());
    const [row] = await db.sql<{ token: string }[]>`SELECT token FROM shares WHERE id = ${share.id}`;
    expect(row!.token).toBe(createHash('sha256').update(token).digest('hex'));
    expect(row!.token).not.toBe(token);

    const list = (await (await h.req('GET', `/api/sessions/${enc('s1')}/shares`, { cookie: a.cookie })).json()) as { shares: ShareView[] };
    expect(list.shares.find((s) => s.id === share.id)).toMatchObject({ kind: 'link', url: null, expiresAt: share.expiresAt });
  });

  it('만료 선택지마다 기한이 맞고, 잘못된 값은 400', async () => {
    const day = (await linkShare('1d')).share;
    expect(new Date(day.expiresAt!).getTime() - h.clock.now.getTime()).toBe(24 * 60 * MIN);
    const week = (await linkShare('7d')).share;
    expect(new Date(week.expiresAt!).getTime() - h.clock.now.getTime()).toBe(7 * 24 * 60 * MIN);
    expect((await linkShare('never')).share.expiresAt).toBeNull();
    expect((await createShare({ kind: 'link', expiresIn: '2h' })).status).toBe(400);
    expect((await createShare({ kind: 'nope' })).status).toBe(400);
  });

  it('소유자가 아니면 만들기·목록·취소 모두 404(관리자·공유받은 사람도)', async () => {
    const { share } = await linkShare();
    for (const cookie of [b.cookie, adminCookie]) {
      expect((await createShare({ kind: 'link', expiresIn: '1h' }, cookie)).status).toBe(404);
      expect((await h.req('GET', `/api/sessions/${enc('s1')}/shares`, { cookie })).status).toBe(404);
      expect((await h.req('DELETE', `/api/shares/${share.id}`, { cookie })).status).toBe(404);
    }
    expect((await createShare({ kind: 'link', expiresIn: '1h' }, a.cookie, 'nope')).status).toBe(404);
    expect((await h.req('POST', `/api/sessions/${enc('s1')}/shares`, { body: { kind: 'link', expiresIn: '1h' } })).status).toBe(401);
  });
});

describe('공개 링크로 보기(로그인 없이) — 새는 것이 없어야 한다', () => {
  it('세션 보기는 PublicSessionView 필드만 담고 컴퓨터·세션 id·경로·소유자·원격 제어 주소가 없다', async () => {
    const { token } = await linkShare('1h');
    const res = await pub(token);
    expect(res.status).toBe(200);
    const raw = await res.text();
    const view = JSON.parse(raw) as PublicSessionView;
    expect(Object.keys(view).sort()).toEqual([
      'activity', 'branch', 'contextPct', 'costUsd', 'endedAt', 'expiresAt', 'lastEventAt', 'model', 'name', 'startedAt', 'status',
    ]);
    expect(view).toMatchObject({ name: 'shared-proj', status: 'run', activity: { label: '질문', text: '공유할 질문' } });
    for (const secret of [a.machineId, 'secret-pc-name', 'owner@example.com', 'owner-claude@example.com', 'abcdef123', 'C:\\\\Users', a.id]) {
      expect(raw).not.toContain(secret);
    }
  });

  it('대화는 그 세션 것만, before·after·around·limit 규칙 그대로', async () => {
    const { token } = await linkShare('1h');
    const log = (await (await pub(token, '/log')).json()) as LogResponse;
    expect(log.lines.map((l) => l.text)).toEqual(['공유된 대화 0', '공유된 대화 1']);
    expect(log.total).toBe(2);
    const after = (await (await pub(token, '/log?after=0')).json()) as LogResponse;
    expect(after.lines.map((l) => l.seq)).toEqual([1]);
    const one = (await (await pub(token, '/log?limit=1')).json()) as LogResponse;
    expect(one).toMatchObject({ hasMoreBefore: true, hasMoreAfter: false });
    expect((await pub(token, '/log?before=1&after=0')).status).toBe(400);
    expect((await pub(token, '/log?limit=9999')).status).toBe(400);
  });

  it('실시간: 그 세션의 상태와 새 줄만 오고(세션 id 없이), 다른 세션 소식은 오지 않는다', async () => {
    const { token } = await linkShare('1h');
    const res = await pub(token, '/stream');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const r = sseReader(res);
    try {
      const first = (await r.nextMessage()) as unknown as PublicStreamMessage;
      expect(first).toMatchObject({ type: 'public', session: { name: 'shared-proj' } });
      // 공유하지 않은 세션의 변화 → 오지 않아야 한다. 이어서 공유한 세션의 새 줄 → 이것이 다음 메시지여야 한다.
      await send([h.ev('s2', 'Stop', { last_assistant_message: '비밀 답' })], {
        transcript: [{ sessionId: 's2', seq: 1, lines: [h.line('비밀 대화 2')] }],
      });
      await send([], { transcript: [{ sessionId: 's1', seq: 2, lines: [h.line('공유된 대화 2')] }] });
      let block: string;
      do block = await r.next(); while (!block.startsWith('data: '));
      expect(block).not.toContain(a.machineId);
      expect(block).not.toContain('비밀');
      const msg = JSON.parse(block.slice(6)) as PublicStreamMessage & Record<string, unknown>;
      expect(msg).toEqual({ type: 'log', lines: [expect.objectContaining({ seq: 2, text: '공유된 대화 2' })] });
      expect('sessionId' in msg).toBe(false);
      // 상태가 바뀌면 public 메시지
      await send([h.ev('s1', 'Stop', { last_assistant_message: '공유 답' })]);
      const next = (await r.nextMessage()) as unknown as PublicStreamMessage;
      expect(next).toMatchObject({ type: 'public', session: { status: 'done', activity: { label: '완료', text: '공유 답' } } });
      expect(JSON.stringify(next)).not.toContain(a.machineId);
    } finally {
      await r.close();
    }
  });

  it('공개 토큰으로는 로그인 API·답장·기기 경로를 쓸 수 없다', async () => {
    const { token } = await linkShare('1h');
    expect((await h.req('POST', `/api/sessions/${enc('s1')}/reply`, { body: { type: 'message', text: 'x' } })).status).toBe(401);
    expect((await h.req('GET', `/api/sessions/${enc('s1')}/log`)).status).toBe(401);
    expect((await h.req('GET', '/api/sessions', { cookie: `cm_session=${token}` })).status).toBe(401);
    expect((await h.req('POST', '/api/ingest', { token, body: h.batch([]) })).status).toBe(401);
    expect((await h.req('POST', '/api/reply/inbox', { token, body: { sessionId: 's1', waiterId: crypto.randomUUID() } })).status).toBe(401);
    // 공개 경로 아래에 다른 하위 경로는 없다
    expect((await pub(token, '/replies')).status).toBe(404);
    expect((await pub(token, '/reply')).status).toBe(404);
  });

  it('모양이 틀린 토큰·없는 토큰은 404', async () => {
    expect((await pub('short')).status).toBe(404);
    expect((await pub('A'.repeat(43))).status).toBe(404);
    expect((await pub('A'.repeat(43), '/log')).status).toBe(404);
    expect((await pub('A'.repeat(43), '/stream')).status).toBe(404);
  });
});

describe('공개 링크가 막히는 경우', () => {
  const allGone = async (token: string) => {
    for (const rest of ['', '/log', '/stream']) expect((await pub(token, rest)).status).toBe(404);
  };

  it('만료되면 404', async () => {
    const { token } = await linkShare('1h');
    expect((await pub(token)).status).toBe(200);
    h.advance(61 * MIN);
    await allGone(token);
  });

  it('취소하면 바로 404, 열려 있던 스트림도 끝난다', async () => {
    const { share, token } = await linkShare();
    const r = sseReader(await pub(token, '/stream'));
    expect((await r.nextMessage() as unknown as PublicStreamMessage).type).toBe('public');
    expect((await h.req('DELETE', `/api/shares/${share.id}`, { cookie: a.cookie })).status).toBe(200);
    await allGone(token);
    expect(await streamEnds(r)).toBe(true);
    // 다시 지우면 404
    expect((await h.req('DELETE', `/api/shares/${share.id}`, { cookie: a.cookie })).status).toBe(404);
  });

  it('소유자가 탈퇴하면 즉시 404(스트림도 끝남), 탈퇴를 취소하면 다시 열린다', async () => {
    const { token } = await linkShare();
    const r = sseReader(await pub(token, '/stream'));
    await r.nextMessage();
    expect((await h.req('POST', '/api/me/withdraw', { cookie: a.cookie })).status).toBe(200);
    await allGone(token);
    expect(await streamEnds(r)).toBe(true);
    expect((await h.req('POST', '/api/me/restore', { cookie: a.cookie })).status).toBe(200);
    expect((await pub(token)).status).toBe(200);
  });

  it('소유자가 정지되면 404', async () => {
    const { token } = await linkShare();
    await db.sql`UPDATE users SET status = 'suspended' WHERE id = ${a.id}`;
    try {
      await allGone(token);
    } finally {
      await db.sql`UPDATE users SET status = 'active' WHERE id = ${a.id}`;
    }
    expect((await pub(token)).status).toBe(200);
  });

  it('세션을 지우면 링크도 사라지고 열려 있던 스트림이 끝난다', async () => {
    await send([h.ev('gone', 'UserPromptSubmit', { prompt: '곧 지울 세션' })]);
    const { token } = await linkShare('never', 'gone');
    const r = sseReader(await pub(token, '/stream'));
    await r.nextMessage();
    await send([h.ev('gone', 'SessionEnd', { reason: 'exit' })]);
    expect((await h.req('DELETE', `/api/sessions/${enc('gone')}`, { cookie: a.cookie })).status).toBe(200);
    await allGone(token);
    expect(await streamEnds(r)).toBe(true);
  });
});

describe('사람 지정 공유', () => {
  let shareId: string;

  it('가입한 사람에게 공유하면 받은 사람 대시보드에 sharedBy가 붙어 보기만 할 수 있게 들어간다', async () => {
    h.published.length = 0;
    const res = await createShare({ kind: 'user', email: '  Friend@Example.com ' });
    expect(res.status).toBe(200);
    const share = (await res.json()) as ShareView;
    shareId = share.id;
    expect(share).toMatchObject({ kind: 'user', url: null, email: 'friend@example.com', expiresAt: null });
    // 받은 사람에게 대시보드가 다시 나간다
    const toB = h.published.filter((p) => p.userId === b.id).map((p) => p.msg);
    expect(toB.some((m) => m.type === 'snapshot' && m.sessions.some((s) => s.id === sid('s1')))).toBe(true);

    const got = (await snap(b.cookie)).sessions.find((s) => s.id === sid('s1'))!;
    expect(got).toMatchObject({ sharedBy: 'owner@example.com', pending: null, canReply: false, queuedMessages: 0, remoteUrl: null });
    // 공유하지 않은 세션과 소유자의 컴퓨터는 보이지 않는다
    const bSnap = await snap(b.cookie);
    expect(bSnap.sessions.map((s) => s.id)).not.toContain(sid('s2'));
    expect(bSnap.machines.map((m) => m.id)).not.toContain(a.machineId);
    // 같은 사람에게 다시 공유하면 같은 공유를 돌려준다
    const again = (await (await createShare({ kind: 'user', email: 'friend@example.com' })).json()) as ShareView;
    expect(again.id).toBe(shareId);
    const list = (await (await h.req('GET', `/api/sessions/${enc('s1')}/shares`, { cookie: a.cookie })).json()) as { shares: ShareView[] };
    expect(list.shares.filter((s) => s.kind === 'user')).toEqual([expect.objectContaining({ id: shareId, email: 'friend@example.com' })]);
  });

  it('자기 자신은 409 self, 가입하지 않은 이메일은 409 user_not_found, 이메일 모양이 틀리면 400', async () => {
    const self = await createShare({ kind: 'user', email: 'owner@example.com' });
    expect(self.status).toBe(409);
    expect(await self.json()).toEqual({ error: 'self' });
    const none = await createShare({ kind: 'user', email: 'nobody@example.com' });
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({ error: 'user_not_found' });
    expect((await createShare({ kind: 'user', email: 'not-an-email' })).status).toBe(400);
  });

  it('받은 사람은 대화·검색·답 기록을 볼 수 있지만 모든 쓰기는 404', async () => {
    expect((await h.req('GET', `/api/sessions/${enc('s1')}/log`, { cookie: b.cookie })).status).toBe(200);
    expect((await h.req('GET', `/api/sessions/${enc('s1')}/search?q=${encodeURIComponent('공유된')}`, { cookie: b.cookie })).status).toBe(200);
    expect((await h.req('GET', `/api/sessions/${enc('s1')}/replies`, { cookie: b.cookie })).status).toBe(200);
    const writes: [string, string, unknown?][] = [
      ['POST', `/api/sessions/${enc('s1')}/reply`, { type: 'message', text: '받은 사람의 글' }],
      ['POST', `/api/sessions/${enc('s1')}/seen`],
      ['PATCH', `/api/sessions/${enc('s1')}`, { telegram: false }],
      ['DELETE', `/api/sessions/${enc('s1')}`],
      ['POST', `/api/sessions/${enc('s1')}/shares`, { kind: 'link', expiresIn: '1h' }],
      ['GET', `/api/sessions/${enc('s1')}/shares`],
      ['DELETE', `/api/shares/${shareId}`],
      ['PATCH', `/api/machines/${a.machineId}`, { remoteReply: false }],
      ['DELETE', `/api/machines/${a.machineId}`],
    ];
    for (const [method, path, body] of writes) {
      expect([method, path, (await h.req(method, path, { cookie: b.cookie, body })).status]).toEqual([method, path, 404]);
    }
    const [m] = await db.sql<{ remote_reply: boolean; revoked_at: Date | null }[]>`SELECT remote_reply, revoked_at FROM machines WHERE id = ${a.machineId}`;
    expect(m).toEqual({ remote_reply: true, revoked_at: null });
    expect((await db.sql`SELECT 1 FROM session_messages WHERE session_id = ${sid('s1')}`).length).toBe(0);
  });

  it('공유받지 않은 사람은 읽기도 404', async () => {
    for (const rest of ['/log', '/replies', `/search?q=${encodeURIComponent('공유된')}`]) {
      expect((await h.req('GET', `/api/sessions/${enc('s1')}${rest}`, { cookie: c.cookie })).status).toBe(404);
    }
    expect((await snap(c.cookie)).sessions.map((s) => s.id)).not.toContain(sid('s1'));
  });

  it('받은 사람의 스트림: 공유된 세션의 변화와 새 줄만(소유자의 다른 세션·컴퓨터 소식 없음), 공유를 취소하면 빠진다', async () => {
    const r = sseReader(await h.req('GET', '/api/stream', { cookie: b.cookie }));
    try {
      const first = await r.nextMessage();
      expect(first.type === 'snapshot' && first.sessions.find((s) => s.id === sid('s1'))?.sharedBy).toBe('owner@example.com');

      // 공유하지 않은 세션의 변화(오지 않아야 함) → 공유된 세션의 변화(와야 함)
      await send([h.ev('s2', 'UserPromptSubmit', { prompt: '비밀 다음 질문' })]);
      await send([h.ev('s1', 'UserPromptSubmit', { prompt: '공유 다음 질문' })], {
        transcript: [{ sessionId: 's1', seq: 3, lines: [h.line('공유된 대화 3')] }],
      });
      const m1 = await r.nextMessage();
      expect(m1).toMatchObject({ type: 'session', session: { id: sid('s1'), sharedBy: 'owner@example.com', canReply: false, remoteUrl: null } });
      const m2 = await r.nextMessage();
      expect(m2).toMatchObject({ type: 'log', sessionId: sid('s1') });

      // 공유 취소 → 받은 사람에게 그 세션이 빠진 대시보드가 다시 간다
      expect((await h.req('DELETE', `/api/shares/${shareId}`, { cookie: a.cookie })).status).toBe(200);
      const m3 = await r.nextMessage();
      expect(m3.type).toBe('snapshot');
      expect(m3.type === 'snapshot' && m3.sessions.map((s) => s.id)).not.toContain(sid('s1'));
      // 이후 그 세션 소식은 오지 않는다 — 받은 사람 자신의 세션 변화가 다음 메시지여야 한다
      await send([h.ev('s1', 'Stop', {})]);
      await h.ingest(b.token, { ...h.batch([h.ev('bs', 'Stop', {})]), machine: { ...MACHINE, name: 'pc-b' } });
      let next: StreamMessage;
      do next = await r.nextMessage(); while (next.type === 'machine');
      expect(next).toMatchObject({ type: 'session', session: { id: `${b.machineId}:bs` } });
    } finally {
      await r.close();
    }
    expect((await h.req('GET', `/api/sessions/${enc('s1')}/log`, { cookie: b.cookie })).status).toBe(404);
  });

  it('소유자가 탈퇴하면 받은 사람 대시보드에서 빠지고 읽기도 404, 취소하면 돌아온다', async () => {
    await createShare({ kind: 'user', email: 'friend@example.com' });
    expect((await snap(b.cookie)).sessions.map((s) => s.id)).toContain(sid('s1'));
    await h.req('POST', '/api/me/withdraw', { cookie: a.cookie });
    expect((await snap(b.cookie)).sessions.map((s) => s.id)).not.toContain(sid('s1'));
    expect((await h.req('GET', `/api/sessions/${enc('s1')}/log`, { cookie: b.cookie })).status).toBe(404);
    await h.req('POST', '/api/me/restore', { cookie: a.cookie });
    expect((await snap(b.cookie)).sessions.map((s) => s.id)).toContain(sid('s1'));
  });
});
