// 웹 푸시(3차): VAPID 키, 구독 API, 알림 종류별 발송(텔레그램과 같은 항목 설정·세션 스위치), 만료 구독 정리,
// 남의 세션 알림이 가지 않는지(Review Focus 4). 가짜 sender만 쓴다 — 실제 푸시 서비스로는 아무것도 나가지 않는다.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { HookEvent, IngestBatch, LimitSnapshot, ReplyAsk } from '@c-monitor/shared';
import { runCleanup } from '../src/jobs/cleanup';
import { runLostCheck } from '../src/jobs/lost';
import { createPushHub } from '../src/notify/push';
import { decryptSecret } from '../src/notify/secret';
import { ADMIN, DAY, MIN, fakePush, makeHarness, makeTestDb, type TestDb } from './helpers';

const fp = fakePush();
let db: TestDb;
let h: ReturnType<typeof makeHarness>;
let adminCookie: string;
let a: { cookie: string; id: string; token: string; machineId: string };
let b: { cookie: string; id: string; token: string; machineId: string };

const MACHINE = { name: 'pc-a', os: 'win32', pluginVersion: '0.2.0' };
const EP_A = 'https://push.example.test/send/a-browser';
const EP_A2 = 'https://push.example.test/send/a-phone';
const EP_B = 'https://push.example.test/send/b-browser';
const KEYS = { p256dh: 'BPk-test-p256dh-key', auth: 'test-auth' };

const send = (events: HookEvent[], extra: Partial<IngestBatch> = {}, token = a.token) =>
  h.ingest(token, { ...h.batch(events, extra), machine: MACHINE });
const sid = (name: string, machineId = a.machineId) => `${machineId}:${name}`;
const settle = () => h.deps.push.idle();
const subscribe = (cookie: string, endpoint: string, label?: string) =>
  h.req('POST', '/api/push/subscribe', { cookie, body: { endpoint, keys: KEYS, ...(label ? { label } : {}) } });

async function running(name: string): Promise<void> {
  expect((await send([h.ev(name, 'UserPromptSubmit', { prompt: '시작' }, { cwd: 'C:\\work\\push-proj' })])).status).toBe(200);
}
async function finish(name: string, message = '다 했습니다'): Promise<void> {
  expect((await send([h.ev(name, 'Stop', { last_assistant_message: message }, { cwd: 'C:\\work\\push-proj' })])).status).toBe(200);
}
function askBody(name: string, over: Partial<ReplyAsk> = {}): ReplyAsk {
  return {
    sessionId: name, kind: 'permission', toolName: 'Bash', toolInput: { command: 'npm test' },
    agentId: null, sessionAllow: null, at: h.clock.now.toISOString(), ...over,
  };
}
const limits = (five: number, seven: number, resets: number): LimitSnapshot => ({
  account: 'a-claude@example.com', fiveHourPct: five, fiveHourResetsAt: resets, sevenDayPct: seven, sevenDayResetsAt: resets + 86_400,
  at: h.clock.now.toISOString(),
});

beforeAll(async () => {
  db = await makeTestDb();
  h = makeHarness(db, { push: createPushHub({ sender: fp.sender, waitGraceMs: 0 }), replyPollMs: 200 });
  adminCookie = await h.login(ADMIN);
  const ua = await h.activeUser('a@example.com');
  const ub = await h.activeUser('b@example.com');
  a = { ...ua, ...(await h.connect(ua.cookie, 'pc-a')) };
  b = { ...ub, ...(await h.connect(ub.cookie, 'pc-b')) };
  await send([]);
});
afterAll(async () => { await db.drop(); });

describe('VAPID 키·구독 API', () => {
  it('공개 키는 처음 쓸 때 만들어 DB에 두고, 비밀 키는 암호화돼 있으며 다른 서버(같은 DB)도 같은 키를 쓴다', async () => {
    const res = await h.req('GET', '/api/push/key', { cookie: a.cookie });
    expect(res.status).toBe(200);
    const { publicKey } = (await res.json()) as { publicKey: string };
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    const [row] = await db.sql<{ public_key: string; private_key_enc: string }[]>`SELECT public_key, private_key_enc FROM push_keys`;
    expect(row!.public_key).toBe(publicKey);
    expect(row!.private_key_enc.startsWith('v1:')).toBe(true);
    const priv = decryptSecret(row!.private_key_enc, 'test-secret', 'push');
    expect(priv).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // 텔레그램용 키로는 풀리지 않는다(용도마다 다른 키)
    expect(decryptSecret(row!.private_key_enc, 'test-secret')).toBeNull();
    const other = makeHarness(db);
    expect(((await (await other.req('GET', '/api/push/key', { cookie: a.cookie })).json()) as { publicKey: string }).publicKey).toBe(publicKey);
  });

  it('구독·목록·해지는 내 것만, 같은 endpoint는 덮어쓰고 다른 사람이 구독하면 그 사람 것으로 바뀐다', async () => {
    expect((await subscribe(a.cookie, EP_A, 'Chrome · Windows')).status).toBe(200);
    expect((await subscribe(a.cookie, EP_A, 'Chrome · Windows 11')).status).toBe(200);
    const list = async (cookie: string) =>
      ((await (await h.req('GET', '/api/push/subscriptions', { cookie })).json()) as { subscriptions: { endpoint: string; label: string | null }[] }).subscriptions;
    expect(await list(a.cookie)).toEqual([{ endpoint: EP_A, label: 'Chrome · Windows 11', createdAt: h.clock.now.toISOString() }]);
    expect(await list(b.cookie)).toEqual([]);

    // B가 같은 브라우저로 구독 → B 것이 된다
    await subscribe(b.cookie, EP_A);
    expect(await list(a.cookie)).toEqual([]);
    expect((await list(b.cookie)).map((s) => s.endpoint)).toEqual([EP_A]);
    // A가 B의 구독을 지우려 해도 그대로
    expect((await h.req('DELETE', '/api/push/subscribe', { cookie: a.cookie, body: { endpoint: EP_A } })).status).toBe(200);
    expect((await list(b.cookie)).map((s) => s.endpoint)).toEqual([EP_A]);
    expect((await h.req('DELETE', '/api/push/subscribe', { cookie: b.cookie, body: { endpoint: EP_A } })).status).toBe(200);
    expect(await list(b.cookie)).toEqual([]);
  });

  it('본문이 틀리면 400, 로그인하지 않으면 401, 승인 대기면 403', async () => {
    expect((await h.req('POST', '/api/push/subscribe', { cookie: a.cookie, body: { endpoint: 'not-a-url', keys: KEYS } })).status).toBe(400);
    expect((await h.req('POST', '/api/push/subscribe', { cookie: a.cookie, body: { endpoint: EP_A } })).status).toBe(400);
    expect((await h.req('GET', '/api/push/key')).status).toBe(401);
    const pending = await h.login('waiting@example.com');
    expect((await h.req('GET', '/api/push/key', { cookie: pending })).status).toBe(403);
    expect((await subscribe(pending, EP_A)).status).toBe(403);
  });

  it('시험 알림: 내 구독이면 보내고, 남의 것·없는 것은 404, 푸시 서비스가 410이면 지우고 404, 그 밖의 실패는 502', async () => {
    await subscribe(a.cookie, EP_A);
    fp.clear();
    expect((await h.req('POST', '/api/push/test', { cookie: a.cookie, body: { endpoint: EP_A } })).status).toBe(200);
    expect(fp.take(EP_A).map((m) => m.payload)).toEqual([{ title: '🔔 c-monitor', body: expect.stringContaining('시험'), url: '/', tag: 'test' }]);
    expect((await h.req('POST', '/api/push/test', { cookie: b.cookie, body: { endpoint: EP_A } })).status).toBe(404);
    expect((await h.req('POST', '/api/push/test', { cookie: a.cookie, body: { endpoint: EP_B } })).status).toBe(404);
    fp.statusOf.set(EP_A, 500);
    expect((await h.req('POST', '/api/push/test', { cookie: a.cookie, body: { endpoint: EP_A } })).status).toBe(502);
    fp.statusOf.set(EP_A, 410);
    expect((await h.req('POST', '/api/push/test', { cookie: a.cookie, body: { endpoint: EP_A } })).status).toBe(404);
    expect((await db.sql`SELECT 1 FROM push_subscriptions WHERE endpoint = ${EP_A}`).length).toBe(0);
    fp.statusOf.delete(EP_A);
  });
});

describe('알림 보내기', () => {
  beforeEach(async () => {
    await settle();
    await subscribe(a.cookie, EP_A);
    await subscribe(a.cookie, EP_A2);
    await subscribe(b.cookie, EP_B);
    fp.clear();
  });

  it('작업이 끝나면 모든 브라우저로 {title, body, url:/?session=, tag}, 남의 브라우저로는 가지 않는다', async () => {
    await running('d1');
    await finish('d1', '테스트가 모두 통과했습니다');
    await settle();
    const toA = fp.take(EP_A);
    expect(toA.map((m) => m.payload)).toEqual([{
      title: '✅ push-proj · pc-a', body: '작업이 끝났습니다: 테스트가 모두 통과했습니다',
      url: `/?session=${encodeURIComponent(sid('d1'))}`, tag: `done:${sid('d1')}`,
    }]);
    expect(fp.take(EP_A2)).toHaveLength(1);
    expect(fp.take(EP_B)).toEqual([]);
    // B의 세션 알림도 A에게 가지 않는다
    await send([h.ev('bd', 'UserPromptSubmit', { prompt: 'x' })], {}, b.token);
    await send([h.ev('bd', 'Stop', { last_assistant_message: 'B 끝' })], {}, b.token);
    await settle();
    expect(fp.take(EP_B)).toHaveLength(1);
    expect(fp.take(EP_A)).toEqual([]);
  });

  it('승인 요청은 한 번만(뒤따르는 wait 전환에도 다시 보내지 않음), 질문도 알린다', async () => {
    await running('w1');
    const res = await h.req('POST', '/api/reply/ask', { token: a.token, body: askBody('w1') });
    expect(res.status).toBe(200);
    await settle();
    await send([h.ev('w1', 'Notification', { notification_type: 'permission_prompt', message: '승인이 필요합니다' })]);
    await settle();
    const got = fp.take(EP_A).map((m) => m.payload);
    expect(got).toEqual([{
      title: '🙋 push-proj · pc-a', body: '승인을 기다립니다 — Bash: npm test',
      url: `/?session=${encodeURIComponent(sid('w1'))}`, tag: `wait:${sid('w1')}`,
    }]);
    await running('q1');
    await h.req('POST', '/api/reply/ask', {
      token: a.token,
      body: askBody('q1', { kind: 'question', toolName: 'AskUserQuestion', toolInput: {}, questions: [{ question: '어느 쪽으로 할까요?', options: [{ label: '가' }] }] }),
    });
    await settle();
    expect(fp.take(EP_A).map((m) => m.payload.body)).toEqual(['질문에 답을 기다립니다: 어느 쪽으로 할까요?']);
  });

  it('요청 없이 답을 기다리면 일반 기다림 알림, 끊기면 끊김 알림', async () => {
    await running('n1');
    await send([h.ev('n1', 'Notification', { notification_type: 'permission_prompt', message: '확인해 주세요' })]);
    await settle();
    expect(fp.take(EP_A).map((m) => m.payload)).toEqual([expect.objectContaining({ body: '답을 기다립니다: 확인해 주세요', tag: `wait:${sid('n1')}` })]);
    await running('l1');
    h.advance(11 * MIN);
    await runLostCheck(h.deps);
    await settle();
    const lost = fp.take(EP_A).map((m) => m.payload).filter((p) => p.tag === `lost:${sid('l1')}`);
    expect(lost).toEqual([expect.objectContaining({ title: '⚠️ push-proj · pc-a', body: expect.stringContaining('연락이 끊겼습니다') })]);
  });

  it('한도가 기준을 넘으면 창마다 한 번만', async () => {
    const reset = Math.floor(h.clock.now.getTime() / 1000) + 3600;
    await send([], { limits: limits(85, 10, reset) });
    await settle();
    expect(fp.take(EP_A).map((m) => m.payload)).toEqual([{
      title: '📊 a-claude@example.com', body: '5시간 한도 85% 사용 (알림 기준 80%)', url: '/', tag: 'limit:a-claude@example.com:five',
    }]);
    h.advance(MIN);
    await send([], { limits: limits(90, 10, reset) });
    await settle();
    expect(fp.take(EP_A)).toEqual([]);
    // 새 창이면 다시
    h.advance(MIN);
    await send([], { limits: limits(90, 10, reset + 5 * 3600) });
    await settle();
    expect(fp.take(EP_A)).toHaveLength(1);
  });

  it('항목 설정(끝남 끔)과 세션별 스위치(알림 끔)를 텔레그램과 똑같이 따른다', async () => {
    expect((await h.req('PUT', '/api/notify/settings', { cookie: a.cookie, body: { done: false } })).status).toBe(200);
    await running('s1');
    await finish('s1');
    await settle();
    expect(fp.take(EP_A)).toEqual([]);
    await h.req('PUT', '/api/notify/settings', { cookie: a.cookie, body: { done: true } });

    await running('s2');
    expect((await h.req('PATCH', `/api/sessions/${encodeURIComponent(sid('s2'))}`, { cookie: a.cookie, body: { telegram: false } })).status).toBe(200);
    await finish('s2');
    await h.req('POST', '/api/reply/ask', { token: a.token, body: askBody('s2') });
    await settle();
    expect(fp.take(EP_A)).toEqual([]);
  });

  it('푸시 서비스가 404·410이면 그 구독만 지우고, 다른 오류는 남겨 둔다', async () => {
    fp.statusOf.set(EP_A, 410);
    fp.statusOf.set(EP_A2, 503);
    await running('g1');
    await finish('g1');
    await settle();
    const left = (await db.sql<{ endpoint: string }[]>`SELECT endpoint FROM push_subscriptions WHERE user_id = ${a.id}`).map((r) => r.endpoint);
    expect(left).toEqual([EP_A2]);
    fp.statusOf.set(EP_A2, 404);
    h.advance(MIN);
    await running('g2');
    await finish('g2');
    await settle();
    expect((await db.sql`SELECT 1 FROM push_subscriptions WHERE user_id = ${a.id}`).length).toBe(0);
    expect((await db.sql`SELECT 1 FROM push_subscriptions WHERE user_id = ${b.id}`).length).toBe(1);
    fp.statusOf.clear();
  });

  it('탈퇴 중인 사용자에게는 보내지 않는다', async () => {
    await running('x1');
    await h.req('POST', '/api/me/withdraw', { cookie: a.cookie });
    // 기기 전송이 막히므로 세션 상태를 바꿀 수 없다 — 끊김 판정으로 알림을 일으켜 본다
    h.advance(11 * MIN);
    await runLostCheck(h.deps);
    await settle();
    expect(fp.take(EP_A)).toEqual([]);
    await h.req('POST', '/api/me/restore', { cookie: a.cookie });
  });

  it('가입 신청(동의)은 웹 푸시를 구독한 관리자에게', async () => {
    const EP_ADMIN = 'https://push.example.test/send/admin';
    await subscribe(adminCookie, EP_ADMIN);
    const joiner = await h.login('joiner@example.com');
    await settle();
    expect(fp.take(EP_ADMIN)).toEqual([]);
    await h.req('POST', '/api/me/consent', { cookie: joiner });
    await settle();
    expect(fp.take(EP_ADMIN).map((m) => m.payload)).toEqual([{
      title: '👤 가입 신청', body: expect.stringContaining('joiner@example.com'), url: '/admin', tag: 'signup',
    }]);
    expect(fp.take(EP_A)).toEqual([]);
  });

  it('한 번만 보낼 알림 기록(push_sent)은 30일 뒤 정리된다', async () => {
    const before = (await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM push_sent`)[0]!.n;
    expect(before).toBeGreaterThan(0);
    h.advance(31 * DAY);
    expect((await runCleanup(h.deps)).pushSent).toBe(before);
  });
});

describe('VAPID 키를 풀 수 없을 때', () => {
  it('SESSION_SECRET이 바뀌면 새 키를 만들고 옛 구독을 지운다', async () => {
    const other = makeHarness(db, { push: createPushHub({ sender: fp.sender }) }, { sessionSecret: 'changed-secret' });
    other.clock.now = h.clock.now;
    // 앞의 정리(31일 뒤)로 로그인 세션이 지워졌으니 다시 로그인한다
    const cookie = await other.login('a@example.com');
    expect((await subscribe(cookie, EP_A)).status).toBe(200);
    const [before] = await db.sql<{ public_key: string }[]>`SELECT public_key FROM push_keys`;
    const res = await other.req('GET', '/api/push/key', { cookie });
    expect(res.status).toBe(200);
    const { publicKey } = (await res.json()) as { publicKey: string };
    expect(publicKey).not.toBe(before!.public_key);
    expect(decryptSecret((await db.sql<{ k: string }[]>`SELECT private_key_enc AS k FROM push_keys`)[0]!.k, 'changed-secret', 'push')).not.toBeNull();
    expect((await db.sql`SELECT 1 FROM push_subscriptions`).length).toBe(0);
  });
});
