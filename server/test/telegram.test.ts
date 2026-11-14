// 알림(텔레그램): 관리자 봇 토큰, 연결 흐름, 설정, 알림 종류별 발송, 버튼·답장, 세션별 스위치.
// 텔레그램은 가짜 클라이언트로만 — 실제 네트워크로는 아무것도 나가지 않는다.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  NOTIFY_DEFAULTS,
  type AdminTelegramView, type HookEvent, type IngestBatch, type NotifyView, type ReplyAsk, type SessionView,
  type TelegramLinkResponse,
} from '@c-monitor/shared';
import { runCleanup } from '../src/jobs/cleanup';
import { runLostCheck } from '../src/jobs/lost';
import { handleUpdate } from '../src/notify/bot';
import { esc, sessionUrl } from '../src/notify/format';
import { createTelegramHub } from '../src/notify/hub';
import { decryptSecret } from '../src/notify/secret';
import { startBotFromDb } from '../src/notify/store';
import {
  TelegramError,
  type EditMessageParams, type InlineKeyboard, type SendMessageParams, type TelegramClient, type TgUpdate,
} from '../src/notify/telegram';
import { ADMIN, DAY, MIN, makeHarness, makeTestDb, type TestDb } from './helpers';

// ── 가짜 텔레그램 ─────────────────────────────────────────
const TOKEN1 = '111111:test_token_one_aaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN2 = '222222:test_token_two_bbbbbbbbbbbbbbbbbbbbbbbbb';
/** getMe는 통과하지만 받기(getUpdates)가 계속 실패하는 토큰 */
const TOKEN_BROKEN = '333333:test_token_broken_ccccccccccccccccccccc';
const BOTS: Record<string, string> = { [TOKEN1]: 'test_one_bot', [TOKEN2]: 'test_two_bot', [TOKEN_BROKEN]: 'test_broken_bot' };

type Sent = SendMessageParams & { token: string; message_id: number };

function fakeTelegram() {
  let nextId = 1000;
  const sent: Sent[] = [];
  const edits: EditMessageParams[] = [];
  const toasts: { callback_query_id: string; text?: string }[] = [];
  const polls: string[] = [];
  /** 다음 sendMessage 몇 번을 429로 거절한다. */
  let fail429 = 0;
  const factory = (token: string): TelegramClient => ({
    async getMe() {
      const username = BOTS[token];
      if (!username) throw new TelegramError('getMe', 401, 'Unauthorized');
      return { id: Number(token.split(':')[0]), username };
    },
    async getUpdates(_params, signal) {
      polls.push(token);
      await new Promise((r) => setTimeout(r, 5));
      if (signal?.aborted) throw new Error('aborted');
      // 실제 fetch 오류처럼 주소(토큰 포함)가 섞인 메시지
      if (token === TOKEN_BROKEN) throw new Error(`fetch failed https://api.telegram.org/bot${token}/getUpdates`);
      return [];
    },
    async sendMessage(params) {
      if (fail429 > 0) {
        fail429--;
        throw new TelegramError('sendMessage', 429, 'Too Many Requests', 2);
      }
      const message_id = nextId++;
      sent.push({ ...params, token, message_id });
      return { message_id };
    },
    async editMessageText(params) {
      edits.push(params);
      return true;
    },
    async answerCallbackQuery(params) {
      toasts.push(params);
      return true;
    },
  });
  return {
    factory, sent, edits, toasts, polls,
    set fail429(n: number) { fail429 = n; },
    /** 그 채팅으로 간 메시지(지금까지 쌓인 것을 비우고 돌려준다). */
    take(chatId?: number): Sent[] {
      const out = sent.filter((m) => chatId === undefined || m.chat_id === chatId);
      sent.splice(0, sent.length, ...sent.filter((m) => !out.includes(m)));
      return out;
    },
    clear() { sent.length = 0; edits.length = 0; toasts.length = 0; },
  };
}

const tg = fakeTelegram();
const sleeps: number[] = [];

let db: TestDb;
let h: ReturnType<typeof makeHarness>;
let adminCookie: string;
let a: { cookie: string; id: string; token: string; machineId: string };
let b: { cookie: string; id: string; token: string; machineId: string };
/** a의 두 번째 컴퓨터(플러그인 0.1.0 — 원격 답장 불가) */
let old: { token: string; machineId: string };

const A_CHAT = 1001;
const B_CHAT = 2002;
const ADMIN_CHAT = 3003;
const MACHINE = { name: 'pc-a', os: 'win32', pluginVersion: '0.2.0' };

beforeAll(async () => {
  db = await makeTestDb();
  h = makeHarness(db, {
    replyPollMs: 15_000,
    telegram: createTelegramHub({
      // 기다리는 시간은 적어 두기만 하고 아주 짧게 쉰다(받기 실패 루프가 너무 빨리 돌지 않을 만큼).
      sleep: async (ms) => { sleeps.push(ms); await new Promise((r) => setTimeout(r, 5)); },
      waitGraceMs: 0,
      pollTimeoutSec: 0,
    }),
    telegramClient: tg.factory,
  });
  adminCookie = await h.login(ADMIN);
  const ua = await h.activeUser('a@example.com');
  const ub = await h.activeUser('b@example.com');
  a = { ...ua, ...(await h.connect(ua.cookie, 'pc-a')) };
  b = { ...ub, ...(await h.connect(ub.cookie, 'pc-b')) };
  old = await h.connect(ua.cookie, 'pc-old');
  await send([]);
  await h.ingest(b.token, { ...h.batch([]), machine: { ...MACHINE, name: 'pc-b' } });
  await h.ingest(old.token, { ...h.batch([]), machine: { name: 'pc-old', os: 'linux', pluginVersion: '0.1.0' } });
});
afterAll(async () => {
  await h.deps.telegram.stop();
  await db.drop();
});

const send = (events: HookEvent[], extra: Partial<IngestBatch> = {}, token = a.token) =>
  h.ingest(token, { ...h.batch(events, extra), machine: MACHINE });
const sid = (name: string, machineId = a.machineId) => `${machineId}:${name}`;
const settle = () => h.deps.telegram.idle();

let updateId = 1;
const from = (chatId: number) => ({ id: chatId, first_name: '앨리스', username: `user${chatId}` });
function textUpdate(chatId: number, text: string, extra: { replyTo?: number; type?: string } = {}): TgUpdate {
  const n = updateId++;
  return {
    update_id: n,
    message: {
      message_id: 90_000 + n, chat: { id: chatId, type: extra.type ?? 'private' }, from: from(chatId), text,
      ...(extra.replyTo !== undefined ? { reply_to_message: { message_id: extra.replyTo } } : {}),
    },
  };
}
function buttonUpdate(chatId: number, data: string, messageId: number): TgUpdate {
  const n = updateId++;
  return { update_id: n, callback_query: { id: `cq-${n}`, from: from(chatId), message: { message_id: messageId, chat: { id: chatId, type: 'private' } }, data } };
}
/** 봇에게 글을 보내고 봇의 답(마지막 메시지 글)을 돌려준다. */
async function say(chatId: number, text: string, extra: { replyTo?: number; type?: string } = {}): Promise<string | undefined> {
  tg.take(chatId);
  await handleUpdate(h.deps, textUpdate(chatId, text, extra));
  return tg.take(chatId).at(-1)?.text;
}
async function press(chatId: number, data: string, messageId: number): Promise<string | undefined> {
  const before = tg.toasts.length;
  await handleUpdate(h.deps, buttonUpdate(chatId, data, messageId));
  return tg.toasts.slice(before).at(-1)?.text;
}
const buttons = (m: Sent): InlineKeyboard => m.reply_markup?.inline_keyboard ?? [];
const dataOf = (m: Sent, label: string): string => {
  const btn = buttons(m).flat().find((x) => x.text === label);
  if (!btn?.callback_data) throw new Error(`버튼 없음: ${label}`);
  return btn.callback_data;
};

async function linkCode(cookie: string): Promise<TelegramLinkResponse> {
  const res = await h.req('POST', '/api/notify/telegram/link', { cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as TelegramLinkResponse;
}
async function link(cookie: string, chatId: number): Promise<void> {
  const { code } = await linkCode(cookie);
  expect(await say(chatId, `/start ${code}`)).toContain('연결되었습니다');
}
async function notifyView(cookie: string): Promise<NotifyView> {
  const res = await h.req('GET', '/api/notify', { cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as NotifyView;
}
async function putToken(token: string, cookie = adminCookie): Promise<Response> {
  return h.req('PUT', '/api/admin/telegram', { cookie, body: { token } });
}
async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('기다리는 조건이 오지 않았습니다');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function askBody(name: string, over: Partial<ReplyAsk> = {}): ReplyAsk {
  return {
    sessionId: name, kind: 'permission', toolName: 'Bash', toolInput: { command: 'npm test' },
    agentId: null, sessionAllow: '이 세션 동안 npm 명령 허용', at: h.clock.now.toISOString(), ...over,
  };
}
async function ask(name: string, over: Partial<ReplyAsk> = {}): Promise<string> {
  const res = await h.req('POST', '/api/reply/ask', { token: a.token, body: askBody(name, over) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { requestId: string }).requestId;
}
async function running(name: string, cwd = 'C:\\work\\proj-a'): Promise<void> {
  expect((await send([h.ev(name, 'UserPromptSubmit', { prompt: '시작' }, { cwd })])).status).toBe(200);
}
async function finish(name: string, message = '다 했습니다', cwd = 'C:\\work\\proj-a'): Promise<void> {
  expect((await send([h.ev(name, 'Stop', { last_assistant_message: message }, { cwd })])).status).toBe(200);
}
async function setNotify(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return h.req('PUT', '/api/notify/settings', { cookie, body });
}

// ══ 관리자: 봇 토큰 ═══════════════════════════════════════
describe('관리자 봇 토큰 (/api/admin/telegram)', () => {
  it('관리자가 아니면 403', async () => {
    expect((await h.req('GET', '/api/admin/telegram', { cookie: a.cookie })).status).toBe(403);
    expect((await putToken(TOKEN1, a.cookie)).status).toBe(403);
    expect((await h.req('DELETE', '/api/admin/telegram', { cookie: a.cookie })).status).toBe(403);
    expect((await h.req('GET', '/api/admin/telegram')).status).toBe(401);
  });

  it('처음에는 꺼져 있고, 사용자 화면도 available=false · 연결 코드는 409', async () => {
    const view = (await (await h.req('GET', '/api/admin/telegram', { cookie: adminCookie })).json()) as AdminTelegramView;
    expect(view).toMatchObject({ configured: false, botUsername: null, tokenHint: null, polling: 'off', linkedUsers: 0 });
    expect((await notifyView(a.cookie)).telegram).toMatchObject({ available: false, botUsername: null, linked: false });
    const res = await h.req('POST', '/api/notify/telegram/link', { cookie: a.cookie });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'telegram_unavailable' });
    expect((await h.req('POST', '/api/notify/telegram/test', { cookie: a.cookie })).status).toBe(409);
  });

  it('형식이 틀리거나 getMe가 거절하면 400 invalid_token, 아무것도 저장하지 않는다', async () => {
    for (const token of ['nope', '999999:unknown_token_zzzzzzzzzzzzzzzzzzzzzzzz']) {
      const res = await putToken(token);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_token' });
    }
    expect((await db.sql`SELECT 1 FROM telegram_bot`).length).toBe(0);
  });

  it('맞는 토큰은 암호화해 저장하고(원문은 DB·응답 어디에도 없다) 받기 루프를 시작한다', async () => {
    const res = await putToken(TOKEN1);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(TOKEN1);
    const view = JSON.parse(text) as AdminTelegramView;
    expect(view).toMatchObject({ configured: true, botUsername: 'test_one_bot', tokenHint: TOKEN1.slice(-4), polling: 'ok', lastError: null });

    const [row] = await db.sql<{ token_enc: string }[]>`SELECT token_enc FROM telegram_bot`;
    const dump = JSON.stringify(await db.sql`SELECT * FROM telegram_bot`);
    expect(dump).not.toContain(TOKEN1);
    expect(dump).not.toContain(TOKEN1.split(':')[1]);
    expect(decryptSecret(row!.token_enc, h.deps.config.sessionSecret)).toBe(TOKEN1);
    expect(decryptSecret(row!.token_enc, 'other-secret')).toBeNull();

    const before = tg.polls.filter((t) => t === TOKEN1).length;
    await until(() => tg.polls.filter((t) => t === TOKEN1).length > before);
    expect((await notifyView(a.cookie)).telegram).toMatchObject({ available: true, botUsername: 'test_one_bot' });
  });

  it('새 토큰을 넣으면 루프를 새 토큰으로 다시 시작한다', async () => {
    expect((await putToken(TOKEN2)).status).toBe(200);
    const mark = tg.polls.length;
    await until(() => tg.polls.slice(mark).filter((t) => t === TOKEN2).length >= 3);
    // 옛 루프는 멈췄다 — 그 뒤로 옛 토큰으로 묻지 않는다(멈추던 순간의 한 번은 있을 수 있다).
    expect(tg.polls.slice(mark).filter((t) => t === TOKEN1).length).toBeLessThanOrEqual(1);
    expect((await notifyView(a.cookie)).telegram.botUsername).toBe('test_two_bot');
  });

  it('받기가 실패하면 polling=error, lastError에 토큰은 가려진다', async () => {
    expect((await putToken(TOKEN_BROKEN)).status).toBe(200);
    let view!: AdminTelegramView;
    await until(() => h.deps.telegram.status().polling === 'error');
    view = (await (await h.req('GET', '/api/admin/telegram', { cookie: adminCookie })).json()) as AdminTelegramView;
    expect(view.polling).toBe('error');
    expect(view.lastError).toContain('fetch failed');
    expect(view.lastError).not.toContain(TOKEN_BROKEN);
    expect(view.lastError).not.toContain(TOKEN_BROKEN.split(':')[1]);
  });

  it('DELETE는 루프를 멈추고 봇을 끈다. 서버를 다시 켜면 DB의 토큰으로 루프를 시작한다', async () => {
    const res = await h.req('DELETE', '/api/admin/telegram', { cookie: adminCookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: false, polling: 'off' });
    expect(h.deps.telegram.bot).toBeNull();
    const mark = tg.polls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(tg.polls.length - mark).toBeLessThanOrEqual(1);

    expect((await putToken(TOKEN1)).status).toBe(200);
    // 서버를 다시 켠 것처럼: 새 허브가 DB에서 토큰을 읽어 시작한다.
    const restarted = makeHarness(db, { telegram: createTelegramHub({ pollTimeoutSec: 0 }), telegramClient: tg.factory });
    expect(await startBotFromDb(restarted.deps)).toBe(true);
    expect(restarted.deps.telegram.bot?.username).toBe('test_one_bot');
    await restarted.deps.telegram.stop();
  });
});

// ══ 연결 ═════════════════════════════════════════════════
describe('연결 (/start 코드)', () => {
  beforeEach(() => tg.clear());

  it('코드 발급 → /start <코드> → 연결되고 이름이 보인다', async () => {
    const { code, url, expiresAt } = await linkCode(a.cookie);
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect(url).toBe(`https://t.me/test_one_bot?start=${code}`);
    expect(new Date(expiresAt).getTime() - h.clock.now.getTime()).toBe(10 * MIN);
    expect(await say(A_CHAT, `/start ${code}`)).toContain('연결되었습니다');
    const view = await notifyView(a.cookie);
    expect(view.telegram).toMatchObject({ available: true, linked: true, linkedName: `@user${A_CHAT}` });
    expect(view.telegram.linkedAt).toBe(h.clock.now.toISOString());
    // 코드는 1회용
    expect(await say(A_CHAT, `/start ${code}`)).toContain('맞지 않습니다');
  });

  it('틀린 코드·코드 없음은 안내만, 새 코드를 받으면 옛 코드는 무효', async () => {
    expect(await say(B_CHAT, '/start WRONG123')).toContain('맞지 않습니다');
    expect(await say(B_CHAT, '/start')).toContain('/start 코드');
    const first = await linkCode(b.cookie);
    const second = await linkCode(b.cookie);
    expect(await say(B_CHAT, `/start ${first.code}`)).toContain('맞지 않습니다');
    expect(await say(B_CHAT, `/start ${second.code.toLowerCase()}`)).toContain('연결되었습니다');
  });

  it('10분이 지난 코드는 만료', async () => {
    const { code } = await linkCode(b.cookie);
    h.advance(11 * MIN);
    expect(await say(B_CHAT, `/start ${code}`)).toContain('만료');
  });

  it('다른 사용자에 연결돼 있던 채팅이면 옮기고, 한 사용자는 채팅 하나만', async () => {
    // a의 채팅(A_CHAT)에 b의 코드를 넣으면 A_CHAT은 b의 것이 되고, b의 옛 채팅·a의 연결은 끊긴다.
    const { code } = await linkCode(b.cookie);
    expect(await say(A_CHAT, `/start ${code}`)).toContain('연결되었습니다');
    expect((await notifyView(a.cookie)).telegram.linked).toBe(false);
    const rows = await db.sql<{ user_id: string; chat_id: string }[]>`SELECT user_id, chat_id FROM telegram_links ORDER BY chat_id`;
    expect(rows.map((r) => [r.user_id, Number(r.chat_id)])).toEqual([[b.id, A_CHAT]]);
    // 원래대로
    await link(a.cookie, A_CHAT);
    await link(b.cookie, B_CHAT);
  });

  it('/stop은 연결을 끊고, 연결 안 된 채팅의 다른 글은 짧은 안내만, 그룹 채팅은 무시', async () => {
    expect(await say(B_CHAT, '/stop')).toContain('끊었습니다');
    expect((await notifyView(b.cookie)).telegram.linked).toBe(false);
    expect(await say(B_CHAT, '안녕')).toContain('/start 코드');
    const { code } = await linkCode(b.cookie);
    expect(await say(-5005, `/start ${code}`, { type: 'group' })).toBeUndefined();
    expect(await say(B_CHAT, `/start ${code}`)).toContain('연결되었습니다');
    expect(await say(B_CHAT, '아무 말')).toContain('답장');
  });

  it('정지된 사용자의 채팅은 연결 안 된 것처럼 다룬다', async () => {
    await db.sql`UPDATE users SET status = 'suspended' WHERE id = ${b.id}`;
    expect(await say(B_CHAT, '아무 말')).toContain('/start 코드');
    await db.sql`UPDATE users SET status = 'active' WHERE id = ${b.id}`;
    expect(await say(B_CHAT, '아무 말')).toContain('답장');
  });

  it('DELETE /api/notify/telegram 은 연결을 끊는다', async () => {
    const res = await h.req('DELETE', '/api/notify/telegram', { cookie: b.cookie });
    expect(((await res.json()) as NotifyView).telegram.linked).toBe(false);
    await link(b.cookie, B_CHAT);
  });

  it('시험 메시지: 연결됐으면 보내고, 아니면 409 not_linked', async () => {
    expect((await h.req('POST', '/api/notify/telegram/test', { cookie: a.cookie })).status).toBe(200);
    expect(tg.take(A_CHAT).at(-1)?.text).toContain('시험 알림');
    const res = await h.req('POST', '/api/notify/telegram/test', { cookie: adminCookie });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_linked' });
  });
});

// ══ 설정 ═════════════════════════════════════════════════
describe('알림 설정', () => {
  it('기본값은 NOTIFY_DEFAULTS, 저장하면 합쳐지고, 범위를 벗어나면 400', async () => {
    expect((await notifyView(b.cookie)).settings).toEqual(NOTIFY_DEFAULTS);
    const res = await setNotify(b.cookie, { done: false, limitPct: 90 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as NotifyView).settings).toEqual({ ...NOTIFY_DEFAULTS, done: false, limitPct: 90 });
    expect((await setNotify(b.cookie, { limitPct: 30 })).status).toBe(400);
    expect((await setNotify(b.cookie, { bogus: true })).status).toBe(400);
    // 다른 설정(PUT /api/settings)을 저장해도 알림 설정은 그대로
    expect((await h.req('PUT', '/api/settings', { cookie: b.cookie, body: { lostMinutes: 15 } })).status).toBe(200);
    expect((await notifyView(b.cookie)).settings).toEqual({ ...NOTIFY_DEFAULTS, done: false, limitPct: 90 });
    await setNotify(b.cookie, NOTIFY_DEFAULTS);
  });
});

// ══ 알림 보내기 ══════════════════════════════════════════
describe('끝남·끊김 알림', () => {
  beforeEach(async () => {
    await settle();
    tg.clear();
  });

  it('작업 중 → 끝남이면 소유자 채팅에만, 마지막 답·답장 안내·세션 링크·끄기 버튼과 함께', async () => {
    await running('d1');
    await finish('d1', '테스트를 고쳤습니다');
    await settle();
    const [m, ...rest] = tg.take(A_CHAT);
    expect(rest).toEqual([]);
    expect(tg.take(B_CHAT)).toEqual([]);
    expect(m!.parse_mode).toBe('HTML');
    expect(m!.text.split('\n')[0]).toBe('✅ <b>proj-a</b> · pc-a');
    expect(m!.text).toContain('테스트를 고쳤습니다');
    expect(m!.text).toContain('답장하면');
    expect(m!.text).toContain(esc(sessionUrl('https://cs.test', sid('d1'))));
    expect(buttons(m!).flat().map((x) => x.text)).toEqual(['🔕 이 세션 알림 끄기']);
    // 버튼 데이터는 64바이트 안
    expect(Buffer.byteLength(dataOf(m!, '🔕 이 세션 알림 끄기'))).toBeLessThanOrEqual(64);
  });

  it('사용자 글은 HTML 이스케이프한다', async () => {
    await running('esc', 'C:\\work\\<b>&x');
    await finish('esc', '<script>alert(1)</script> & "따옴표"', 'C:\\work\\<b>&x');
    await settle();
    const [m] = tg.take(A_CHAT);
    expect(m!.text).toContain('<b>&lt;b&gt;&amp;x</b>');
    expect(m!.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;따옴표&quot;');
    expect(m!.text).not.toContain('<script>');
  });

  it('같은 세션의 끝남은 30초 안에 한 번만', async () => {
    await running('d2');
    await finish('d2');
    await running('d2');
    await finish('d2');
    await settle();
    expect(tg.take(A_CHAT)).toHaveLength(1);
    h.advance(31_000);
    await running('d2');
    await finish('d2');
    await settle();
    expect(tg.take(A_CHAT)).toHaveLength(1);
  });

  it('끝남 알림을 끄면 가지 않고, 이미 끝난 세션에 Stop이 다시 와도 가지 않는다', async () => {
    await setNotify(a.cookie, { done: false });
    await running('d3');
    await finish('d3');
    await settle();
    expect(tg.take(A_CHAT)).toEqual([]);
    await setNotify(a.cookie, { done: true });
    h.advance(31_000);
    await finish('d3');
    await settle();
    expect(tg.take(A_CHAT)).toEqual([]);
  });

  it('연락 끊김(끊김 판정)도 알리고, 끄면 가지 않는다', async () => {
    await running('l1');
    await running('l2');
    h.advance(11 * MIN);
    expect(await runLostCheck(h.deps)).toBeGreaterThanOrEqual(2);
    await settle();
    const msgs = tg.take(A_CHAT);
    expect(msgs.filter((m) => m.text.startsWith('⚠️'))).toHaveLength(2);

    await setNotify(a.cookie, { lost: false });
    await running('l3');
    h.advance(11 * MIN);
    await runLostCheck(h.deps);
    await settle();
    expect(tg.take(A_CHAT)).toEqual([]);
    await setNotify(a.cookie, { lost: true });
  });

  it('429면 retry_after만큼 기다렸다 다시 보낸다', async () => {
    sleeps.length = 0;
    tg.fail429 = 1;
    await running('r429');
    await finish('r429');
    await settle();
    expect(tg.take(A_CHAT)).toHaveLength(1);
    expect(sleeps).toContain(2000);
  });
});

describe('기다림 알림·버튼', () => {
  beforeEach(async () => {
    await settle();
    tg.clear();
  });

  it('승인 요청은 무엇을 묻는지와 버튼을 붙여 한 번만 보낸다(뒤따른 알림 훅으로 또 보내지 않음)', async () => {
    await running('w1');
    await ask('w1');
    await send([h.ev('w1', 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' })]);
    await settle();
    const msgs = tg.take(A_CHAT);
    expect(msgs).toHaveLength(1);
    const m = msgs[0]!;
    expect(m.text.split('\n')[0]).toBe('🙋 <b>proj-a</b> · pc-a');
    expect(m.text).toContain('<b>Bash</b>');
    expect(m.text).toContain('<pre>npm test</pre>');
    expect(buttons(m).flat().map((x) => x.text)).toEqual(['허용', '이 세션 동안 허용', '거부', '🔕 이 세션 알림 끄기']);
    for (const btn of buttons(m).flat()) expect(Buffer.byteLength(btn.callback_data!)).toBeLessThanOrEqual(64);
  });

  it('허용 버튼 → 2차의 wait가 답을 받고, 메시지는 "✓ 허용함"으로 바뀌며 버튼이 사라진다', async () => {
    await running('w2');
    const requestId = await ask('w2');
    await settle();
    const [m] = tg.take(A_CHAT);
    const waiting = h.req('POST', '/api/reply/wait', { token: a.token, body: { requestId } });
    await new Promise((r) => setTimeout(r, 50));
    expect(await press(A_CHAT, dataOf(m!, '허용'), m!.message_id)).toBe('허용했습니다');
    expect(await (await waiting).json()).toEqual({ status: 'answered', answer: { type: 'permission', behavior: 'allow' } });
    const edit = tg.edits.at(-1)!;
    expect(edit.message_id).toBe(m!.message_id);
    expect(edit.text).toContain('✓ 허용함');
    expect(edit.reply_markup?.inline_keyboard).toEqual([]);
  });

  it('이 세션 동안 허용·거부도 같은 처리, 이미 끝난 요청이면 "이미 터미널에서 답했습니다"', async () => {
    await running('w3');
    const r1 = await ask('w3');
    await settle();
    const [m1] = tg.take(A_CHAT);
    expect(await press(A_CHAT, dataOf(m1!, '이 세션 동안 허용'), m1!.message_id)).toBe('이 세션 동안 허용했습니다');
    const [row] = await db.sql<{ answer: unknown }[]>`SELECT answer FROM reply_requests WHERE id = ${r1}`;
    expect(row!.answer).toEqual({ type: 'permission', behavior: 'allow_session' });

    // 두 번째 요청은 터미널에서 먼저 답함(뒤따른 PostToolUse로 치워짐)
    const r2 = await ask('w3');
    await settle();
    const [m2] = tg.take(A_CHAT);
    h.advance(1000);
    await send([h.ev('w3', 'PostToolUse', { tool_name: 'Bash' })]);
    expect(await press(A_CHAT, dataOf(m2!, '거부'), m2!.message_id)).toBe('이미 터미널에서 답했습니다');
    expect(tg.edits.at(-1)!.text).toContain('이미 끝난 요청');
    const [st] = await db.sql<{ status: string }[]>`SELECT status FROM reply_requests WHERE id = ${r2}`;
    expect(st!.status).toBe('gone');
  });

  it('남의 세션 버튼은 눌러도 안 된다(채팅이 다른 사용자에게 옮겨진 경우)', async () => {
    await running('w4');
    const requestId = await ask('w4');
    await settle();
    const [m] = tg.take(A_CHAT);
    // A_CHAT을 b에게 옮긴다
    const { code } = await linkCode(b.cookie);
    expect(await say(A_CHAT, `/start ${code}`)).toContain('연결되었습니다');
    expect(await press(A_CHAT, dataOf(m!, '허용'), m!.message_id)).toBe('이 세션에 답할 수 없습니다');
    expect(await press(A_CHAT, dataOf(m!, '🔕 이 세션 알림 끄기'), m!.message_id)).toBe('이 세션을 바꿀 수 없습니다');
    // 다른 채팅에서 같은 데이터를 보내도(메시지가 그 채팅 것이 아님) 처리하지 않는다
    expect(await press(B_CHAT, dataOf(m!, '허용'), m!.message_id)).toBe('연결되지 않은 채팅입니다');
    const [st] = await db.sql<{ status: string }[]>`SELECT status FROM reply_requests WHERE id = ${requestId}`;
    expect(st!.status).toBe('pending');
    const [s] = await db.sql<{ telegram: boolean }[]>`SELECT telegram FROM sessions WHERE id = ${sid('w4')}`;
    expect(s!.telegram).toBe(true);
    await link(a.cookie, A_CHAT);
    await link(b.cookie, B_CHAT);
  });

  it('질문 1개·단일 선택이면 선택지 버튼, 누르면 그 label로 답한다', async () => {
    await running('q1');
    const requestId = await ask('q1', {
      kind: 'question', toolName: 'AskUserQuestion', toolInput: {}, sessionAllow: null,
      questions: [{ question: '어느 쪽으로 할까요?', header: '방식', options: [{ label: '빠르게' }, { label: '<꼼꼼하게>' }] }],
    });
    await settle();
    const [m] = tg.take(A_CHAT);
    expect(m!.text.startsWith('❓')).toBe(true);
    expect(m!.text).toContain('&lt;꼼꼼하게&gt;');
    expect(buttons(m!).flat().map((x) => x.text)).toEqual(['빠르게', '<꼼꼼하게>', '🔕 이 세션 알림 끄기']);
    expect(await press(A_CHAT, dataOf(m!, '<꼼꼼하게>'), m!.message_id)).toBe('답을 보냈습니다');
    const [row] = await db.sql<{ answer: unknown }[]>`SELECT answer FROM reply_requests WHERE id = ${requestId}`;
    expect(row!.answer).toEqual({ type: 'answer', answers: { '어느 쪽으로 할까요?': '<꼼꼼하게>' } });
  });

  it('여러 개 고르기·질문 여러 개면 선택지 버튼 없이 "대시보드에서 답하기"', async () => {
    await running('q2');
    await ask('q2', {
      kind: 'question', toolName: 'AskUserQuestion', toolInput: {}, sessionAllow: null,
      questions: [{ question: '무엇을 넣을까요?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }],
    });
    await settle();
    const [m] = tg.take(A_CHAT);
    expect(m!.text).toContain('대시보드에서 답하기');
    expect(buttons(m!).flat().map((x) => x.text)).toEqual(['🔕 이 세션 알림 끄기']);
  });

  it('원격 답장을 못 하는 컴퓨터(플러그인 0.1.0)의 기다림은 버튼 없이 알림만', async () => {
    const name = 'old1';
    await h.ingest(old.token, {
      ...h.batch([
        h.ev(name, 'UserPromptSubmit', { prompt: '시작' }),
        h.ev(name, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }),
      ]),
      machine: { name: 'pc-old', os: 'linux', pluginVersion: '0.1.0' },
    });
    await settle();
    const [m, ...rest] = tg.take(A_CHAT);
    expect(rest).toEqual([]);
    expect(m!.text.split('\n')[0]).toBe('🙋 <b>proj-a</b> · pc-old');
    expect(m!.text).toContain('Claude needs your permission to use Bash');
    expect(buttons(m!).flat().map((x) => x.text)).toEqual(['🔕 이 세션 알림 끄기']);
  });

  it('기다림 알림을 끄면 승인 요청도 알리지 않는다', async () => {
    await setNotify(a.cookie, { wait: false });
    await running('w5');
    await ask('w5');
    await settle();
    expect(tg.take(A_CHAT)).toEqual([]);
    await setNotify(a.cookie, { wait: true });
  });

  it('일반 기다림 뒤 곧 승인 요청이 오면(유예 시간 안) 버튼 있는 알림 하나만 간다', async () => {
    const graced = makeHarness(db, { telegram: createTelegramHub({ waitGraceMs: 150, pollTimeoutSec: 0 }), telegramClient: tg.factory });
    await graced.deps.telegram.start(graced.deps, { client: tg.factory(TOKEN1), username: 'test_one_bot', token: TOKEN1 });
    try {
      graced.clock.now = h.clock.now;
      const batch = (events: HookEvent[]) => graced.ingest(a.token, { ...graced.batch(events), machine: MACHINE });
      await batch([graced.ev('g1', 'UserPromptSubmit', { prompt: '시작' })]);
      await batch([graced.ev('g1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: {} })]);
      const res = await graced.req('POST', '/api/reply/ask', { token: a.token, body: askBody('g1') });
      expect(res.status).toBe(200);
      await graced.deps.telegram.idle();
      const msgs = tg.take(A_CHAT);
      expect(msgs).toHaveLength(1);
      expect(buttons(msgs[0]!).flat().map((x) => x.text)).toContain('허용');
    } finally {
      await graced.deps.telegram.stop();
    }
  });
});

describe('답장 글', () => {
  beforeEach(async () => {
    await settle();
    tg.clear();
  });

  it('끝남 알림에 답장 → 그 세션에 글(작업 중이 아니면 쌓였다가 전달)', async () => {
    await running('t1');
    await finish('t1');
    await settle();
    const [m] = tg.take(A_CHAT);
    expect(await say(A_CHAT, '이제 문서도 고쳐 줘', { replyTo: m!.message_id })).toContain('보냈습니다');
    const rows = await db.sql<{ text: string }[]>`SELECT text FROM session_messages WHERE session_id = ${sid('t1')} AND delivered_at IS NULL`;
    expect(rows.map((r) => r.text)).toEqual(['이제 문서도 고쳐 줘']);
    // 대기자가 붙으면 그 글이 넘어간다
    const res = await h.req('POST', '/api/reply/inbox', { token: a.token, body: { sessionId: 't1', waiterId: randomUUID() } });
    expect(await res.json()).toMatchObject({ status: 'message', text: '이제 문서도 고쳐 줘' });
  });

  it('승인 대기 중이면 거부+글, 질문 대기 중이면 첫 질문의 답', async () => {
    await running('t2');
    const r1 = await ask('t2');
    await settle();
    const [m] = tg.take(A_CHAT);
    expect(await say(A_CHAT, '그 명령 말고 npm run lint', { replyTo: m!.message_id })).toContain('거부하고');
    const [row1] = await db.sql<{ answer: unknown }[]>`SELECT answer FROM reply_requests WHERE id = ${r1}`;
    expect(row1!.answer).toEqual({ type: 'permission', behavior: 'deny', message: '그 명령 말고 npm run lint' });

    const r2 = await ask('t2', {
      kind: 'question', toolName: 'AskUserQuestion', toolInput: {}, sessionAllow: null,
      questions: [{ question: '이름은?', options: [{ label: 'x' }] }],
    });
    expect(await say(A_CHAT, '직접 쓴 이름', { replyTo: m!.message_id })).toContain('답을 보냈습니다');
    const [row2] = await db.sql<{ answer: unknown }[]>`SELECT answer FROM reply_requests WHERE id = ${r2}`;
    expect(row2!.answer).toEqual({ type: 'answer', answers: { '이름은?': '직접 쓴 이름' } });
  });

  it('모르는 메시지에 답장·너무 긴 글·남의 세션은 안내만', async () => {
    expect(await say(A_CHAT, '여보세요', { replyTo: 123 })).toContain('찾지 못했습니다');
    await running('t3');
    await finish('t3');
    await settle();
    const [m] = tg.take(A_CHAT);
    expect(await say(A_CHAT, 'x'.repeat(4001), { replyTo: m!.message_id })).toContain('너무 깁니다');
    // 채팅을 b에게 옮기면 a의 세션에는 보낼 수 없다
    const { code } = await linkCode(b.cookie);
    await say(A_CHAT, `/start ${code}`);
    expect(await say(A_CHAT, '남의 세션', { replyTo: m!.message_id })).toContain('답할 수 없습니다');
    expect((await db.sql`SELECT 1 FROM session_messages WHERE session_id = ${sid('t3')}`).length).toBe(0);
    await link(a.cookie, A_CHAT);
    await link(b.cookie, B_CHAT);
  });
});

describe('세션별 텔레그램 스위치', () => {
  beforeEach(async () => {
    await settle();
    tg.clear();
  });

  it('기본은 켬, PATCH로 끄면 session을 내보내고 어떤 알림도 가지 않는다', async () => {
    await running('s1');
    const list = (await (await h.req('GET', '/api/sessions', { cookie: a.cookie })).json()) as { sessions: SessionView[] };
    expect(list.sessions.find((s) => s.id === sid('s1'))!.telegram).toBe(true);

    h.published.length = 0;
    const res = await h.req('PATCH', `/api/sessions/${encodeURIComponent(sid('s1'))}`, { cookie: a.cookie, body: { telegram: false } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { session: SessionView }).session.telegram).toBe(false);
    expect(h.published.some((p) => p.userId === a.id && p.msg.type === 'session' && p.msg.session.id === sid('s1') && !p.msg.session.telegram)).toBe(true);

    await finish('s1');
    await running('s1');
    await ask('s1');
    await settle();
    expect(tg.take(A_CHAT)).toEqual([]);
  });

  it('남의 세션·없는 세션은 404, 잘못된 본문은 400', async () => {
    const path = `/api/sessions/${encodeURIComponent(sid('s1'))}`;
    expect((await h.req('PATCH', path, { cookie: b.cookie, body: { telegram: true } })).status).toBe(404);
    expect((await h.req('PATCH', path, { cookie: adminCookie, body: { telegram: true } })).status).toBe(404);
    expect((await h.req('PATCH', '/api/sessions/none', { cookie: a.cookie, body: { telegram: true } })).status).toBe(404);
    expect((await h.req('PATCH', path, { cookie: a.cookie, body: { telegram: 'yes' } })).status).toBe(400);
  });

  it('알림의 "이 세션 알림 끄기" 버튼은 스위치를 끄고, 그 버튼만 없앤다', async () => {
    await running('s2');
    await ask('s2');
    await settle();
    const [m] = tg.take(A_CHAT);
    h.published.length = 0;
    expect(await press(A_CHAT, dataOf(m!, '🔕 이 세션 알림 끄기'), m!.message_id)).toBe('이 세션 알림을 껐습니다');
    const [s] = await db.sql<{ telegram: boolean }[]>`SELECT telegram FROM sessions WHERE id = ${sid('s2')}`;
    expect(s!.telegram).toBe(false);
    expect(h.published.some((p) => p.msg.type === 'session' && p.msg.session.id === sid('s2'))).toBe(true);
    const edit = tg.edits.at(-1)!;
    expect(edit.text).toContain('알림을 껐습니다');
    expect(edit.reply_markup!.inline_keyboard.flat().map((x) => x.text)).toEqual(['허용', '이 세션 동안 허용', '거부']);
    // 남은 승인 버튼은 그대로 쓸 수 있다
    expect(await press(A_CHAT, dataOf(m!, '허용'), m!.message_id)).toBe('허용했습니다');
    await finish('s2');
    await settle();
    expect(tg.take(A_CHAT)).toEqual([]);
  });
});

describe('한도 알림', () => {
  const RESET1 = 1_800_000_000;
  const limits = (five: number, seven: number, fiveResets = RESET1) => ({
    account: 'dev@example.com', fiveHourPct: five, fiveHourResetsAt: fiveResets, sevenDayPct: seven,
    sevenDayResetsAt: RESET1 + 5 * 86_400, at: h.clock.now.toISOString(),
  });
  beforeEach(async () => {
    await settle();
    tg.clear();
    h.advance(MIN);
  });

  it('기준 미만이면 없음, 처음 넘으면 한 번, 같은 창에서는 다시 안 보냄, 새 창이면 다시', async () => {
    await send([], { limits: limits(50, 10) });
    await settle();
    expect(tg.take(A_CHAT)).toEqual([]);

    h.advance(MIN);
    await send([], { limits: limits(85, 10) });
    await settle();
    const [m, ...rest] = tg.take(A_CHAT);
    expect(rest).toEqual([]);
    expect(m!.text.split('\n')[0]).toBe('📊 <b>dev@example.com</b>');
    expect(m!.text).toContain('5시간 한도 85% 사용 (알림 기준 80%)');

    h.advance(MIN);
    await send([], { limits: limits(95, 10) });
    await settle();
    expect(tg.take(A_CHAT)).toEqual([]);

    h.advance(MIN);
    await send([], { limits: limits(81, 82, RESET1 + 5 * 3600) });
    await settle();
    const msgs = tg.take(A_CHAT);
    expect(msgs.map((x) => x.text.split('\n')[1])).toEqual([
      '5시간 한도 81% 사용 (알림 기준 80%)', '주간 한도 82% 사용 (알림 기준 80%)',
    ]);
    expect(tg.take(B_CHAT)).toEqual([]);
  });

  it('한도 알림을 끄거나 기준을 올리면 보내지 않는다', async () => {
    await setNotify(a.cookie, { limitPct: 99 });
    await send([], { limits: limits(90, 90, RESET1 + 10 * 3600) });
    await settle();
    expect(tg.take(A_CHAT)).toEqual([]);
    await setNotify(a.cookie, { limit: false, limitPct: 80 });
    h.advance(MIN);
    await send([], { limits: limits(90, 90, RESET1 + 20 * 3600) });
    await settle();
    expect(tg.take(A_CHAT)).toEqual([]);
    await setNotify(a.cookie, { limit: true });
  });
});

describe('가입 신청 알림', () => {
  beforeEach(async () => {
    await settle();
    tg.clear();
  });

  it('새 가입 신청은 텔레그램을 연결한 관리자에게만', async () => {
    await link(adminCookie, ADMIN_CHAT);
    tg.clear();
    await h.login('newbie@example.com');
    await settle();
    const [m, ...rest] = tg.take(ADMIN_CHAT);
    expect(rest).toEqual([]);
    expect(m!.text).toContain('가입 신청');
    expect(m!.text).toContain('newbie@example.com');
    expect(m!.text).toContain('https://cs.test/admin');
    expect(tg.take(A_CHAT)).toEqual([]);
    // 이미 있는 사용자가 다시 로그인하면 보내지 않는다
    await h.login('newbie@example.com');
    await settle();
    expect(tg.take(ADMIN_CHAT)).toEqual([]);
  });
});

describe('봇이 없을 때 · 정리 · 삭제', () => {
  it('봇이 없는 서버는 알림을 보내지 않고 오류도 없다', async () => {
    const off = makeHarness(db, { telegramClient: tg.factory });
    off.clock.now = h.clock.now;
    const view = (await (await off.req('GET', '/api/notify', { cookie: a.cookie })).json()) as NotifyView;
    expect(view.telegram).toMatchObject({ available: false, botUsername: null, linked: true });
    expect((await off.req('POST', '/api/notify/telegram/link', { cookie: a.cookie })).status).toBe(409);
    tg.clear();
    const res = await off.ingest(a.token, { ...off.batch([off.ev('n1', 'UserPromptSubmit', { prompt: 'x' }), off.ev('n1', 'Stop', {})]), machine: MACHINE });
    expect(res.status).toBe(200);
    await off.deps.telegram.idle();
    expect(tg.sent).toEqual([]);
  });

  it('보낸 메시지 기록은 7일, 만료된 연결 코드는 정리된다', async () => {
    await linkCode(b.cookie);
    const before = (await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM telegram_messages`)[0]!.n;
    expect(before).toBeGreaterThan(0);
    h.advance(8 * DAY);
    const result = await runCleanup(h.deps);
    expect(result.telegramMessages).toBe(before);
    expect(result.telegramCodes).toBeGreaterThanOrEqual(1);
  });

  it('사용자를 지우면 연결·코드·설정·메시지 기록도 함께 지워진다(CASCADE)', async () => {
    const c = await h.activeUser('gone@example.com');
    await link(c.cookie, 7007);
    await linkCode(c.cookie);
    await db.sql`DELETE FROM users WHERE id = ${c.id}`;
    expect((await db.sql`SELECT 1 FROM telegram_links WHERE user_id = ${c.id}`).length).toBe(0);
    expect((await db.sql`SELECT 1 FROM telegram_link_codes WHERE user_id = ${c.id}`).length).toBe(0);
  });
});
