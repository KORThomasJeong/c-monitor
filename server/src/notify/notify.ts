// 무엇을 언제 누구에게 알리는가. 텔레그램(deps.telegram 큐)과 웹 푸시(deps.push 큐)로 보내고 바로 돌아온다(요청 처리를 막지 않는다).
// 두 길은 같은 항목 설정(NotifySettings)과 세션별 스위치(sessions.telegram = "알림" 스위치)를 따른다.
// 받는 사람은 세션의 소유자 한 명뿐이다(공유받은 사람·관리자에게는 남의 세션을 알리지 않는다).
import { NOTIFY_DEFAULTS, type LimitSnapshot, type NotifySettings, type ReplyQuestion, type SessionStatus } from '@c-monitor/shared';
import { folderName } from '../query/views';
import { machineCanReply, summaryOf } from '../reply/pending';
import type { Deps, Q } from '../types';
import {
  doneText, limitText, lostText, muteRow, optionButtons, permissionButtons, signupText, trimText, waitRequestText, waitText,
  type SessionHead,
} from './format';
import type { TelegramBot } from './hub';
import { hasPushTargets, pushOnce, pushText, sendPush, type PushHead } from './push';
import { errorLine, type InlineKeyboard } from './telegram';

type NotifyDeps = Pick<Deps, 'sql' | 'config' | 'now' | 'telegram' | 'push'>;

/** 세션 상태가 바뀐 것 하나. text는 알림에 붙일 한 줄(끝남: 마지막 답, 기다림: 알림 문구). */
export type StatusChange = { sessionId: string; from: SessionStatus | null; to: SessionStatus; text?: string };

type Target = { chatId: number; settings: NotifySettings };

export type NotifyRow = {
  notify_wait: boolean; notify_done: boolean; notify_lost: boolean; notify_limit: boolean; notify_limit_pct: number;
};

/** settings 행 → 알림 설정. 행이 없으면(LEFT JOIN으로 모두 null) 기본값. */
export function settingsFromRow(r: { [K in keyof NotifyRow]: NotifyRow[K] | null } | undefined): NotifySettings {
  if (!r || r.notify_wait === null) return { ...NOTIFY_DEFAULTS };
  return {
    wait: r.notify_wait, done: r.notify_done ?? NOTIFY_DEFAULTS.done, lost: r.notify_lost ?? NOTIFY_DEFAULTS.lost,
    limit: r.notify_limit ?? NOTIFY_DEFAULTS.limit, limitPct: r.notify_limit_pct ?? NOTIFY_DEFAULTS.limitPct,
  };
}

/** 알림을 받을 채팅과 설정. 연결하지 않았거나 승인된 사용자가 아니면 null. */
export async function loadTarget(sql: Q, userId: string): Promise<Target | null> {
  const [r] = await sql<({ chat_id: string } & { [K in keyof NotifyRow]: NotifyRow[K] | null })[]>`
    SELECT l.chat_id, st.notify_wait, st.notify_done, st.notify_lost, st.notify_limit, st.notify_limit_pct
    FROM telegram_links l JOIN users u ON u.id = l.user_id LEFT JOIN settings st ON st.user_id = l.user_id
    WHERE l.user_id = ${userId} AND u.status = 'active' AND u.delete_at IS NULL`;
  if (!r) return null;
  return { chatId: Number(r.chat_id), settings: settingsFromRow(r) };
}

/** 웹 푸시를 받을 사용자의 항목 설정. 구독이 없거나 승인된 사용자가 아니면(탈퇴 중 포함) null. */
async function loadPushSettings(sql: Q, userId: string): Promise<NotifySettings | null> {
  if (!(await hasPushTargets(sql, userId))) return null;
  const [r] = await sql<{ [K in keyof NotifyRow]: NotifyRow[K] | null }[]>`
    SELECT notify_wait, notify_done, notify_lost, notify_limit, notify_limit_pct FROM settings WHERE user_id = ${userId}`;
  return settingsFromRow(r);
}

type SessionInfo = {
  id: string; user_id: string; cwd: string; status: SessionStatus; telegram: boolean;
  activity_text: string | null; machine_name: string; can_reply: boolean;
};

async function loadSession(sql: Q, sessionId: string): Promise<SessionInfo | null> {
  const [r] = await sql<(Omit<SessionInfo, 'can_reply'> & { remote_reply: boolean; plugin_version: string; revoked_at: Date | null })[]>`
    SELECT s.id, s.user_id, s.cwd, s.status, s.telegram, s.activity_text,
           m.name AS machine_name, m.remote_reply, m.plugin_version, m.revoked_at
    FROM sessions s JOIN machines m ON m.id = s.machine_id WHERE s.id = ${sessionId}`;
  if (!r) return null;
  return {
    id: r.id, user_id: r.user_id, cwd: r.cwd, status: r.status, telegram: r.telegram, activity_text: r.activity_text,
    machine_name: r.machine_name,
    can_reply: machineCanReply({ remoteReply: r.remote_reply, revoked: r.revoked_at !== null, pluginVersion: r.plugin_version }),
  };
}

const headOf = (deps: NotifyDeps, s: SessionInfo): SessionHead => ({
  sessionId: s.id, name: folderName(s.cwd), machine: s.machine_name, publicUrl: deps.config.publicUrl,
});
const pushHeadOf = (s: SessionInfo): PushHead => ({ sessionId: s.id, name: folderName(s.cwd), machine: s.machine_name });

/**
 * 메시지를 보내고 telegram_messages에 적는다(답장·버튼이 어느 세션 것인지 찾으려고).
 * 버튼의 callback_data에 행 id가 들어가므로 행을 먼저 만들고 보낸다. 보내지 못하면 행을 지운다.
 */
export async function sendTracked(deps: NotifyDeps, bot: TelegramBot, m: {
  userId: string; chatId: number; sessionId: string | null; requestId?: string | null; html: string;
  keyboard?: (rowId: string) => InlineKeyboard;
}): Promise<void> {
  const { sql } = deps;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO telegram_messages (chat_id, user_id, session_id, request_id, html, created_at)
    VALUES (${m.chatId}, ${m.userId}, ${m.sessionId}, ${m.requestId ?? null}, ${m.html}, ${deps.now()})
    RETURNING id`;
  const rowId = String(row!.id);
  const keyboard = m.keyboard?.(rowId) ?? [];
  try {
    const sent = await deps.telegram.call(() => bot.client.sendMessage({
      chat_id: m.chatId, text: m.html, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      ...(keyboard.length > 0 ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    }));
    await sql`
      UPDATE telegram_messages SET message_id = ${sent.message_id}, keyboard = ${keyboard.length > 0 ? sql.json(keyboard as never) : null}
      WHERE id = ${rowId}`;
  } catch (err) {
    await sql`DELETE FROM telegram_messages WHERE id = ${rowId}`;
    throw err;
  }
}

// ── 승인·질문 ───────────────────────────────────────────

type RequestRow = {
  id: string; session_id: string; kind: 'permission' | 'question'; tool_name: string; tool_input: unknown;
  questions: ReplyQuestion[] | null; session_allow: string | null;
};

/** 그 요청을 알린 적이 있는가(같은 요청에 두 번 보내지 않는다). */
async function requestNotified(sql: Q, requestId: string): Promise<boolean> {
  return (await sql`SELECT 1 FROM telegram_messages WHERE request_id = ${requestId} LIMIT 1`).length > 0;
}

async function sendRequest(deps: NotifyDeps, bot: TelegramBot, s: SessionInfo, r: RequestRow, target: Target): Promise<void> {
  const q0 = r.questions?.[0];
  const buttons = s.can_reply;
  const optionChoice = buttons && r.kind === 'question' && r.questions?.length === 1 && !!q0 && !q0.multiSelect && q0.options.length > 0;
  const html = waitRequestText(headOf(deps, s), {
    kind: r.kind, toolName: r.tool_name, summary: summaryOf(r.tool_input, r.questions), questions: r.questions,
    buttons, optionButtons: optionChoice, canReply: s.can_reply,
  });
  await sendTracked(deps, bot, {
    userId: s.user_id, chatId: target.chatId, sessionId: s.id, requestId: r.id, html,
    keyboard: (rowId) => [
      ...(buttons && r.kind === 'permission' ? permissionButtons(rowId, r.session_allow !== null) : []),
      ...(optionChoice ? optionButtons(rowId, q0!) : []),
      ...muteRow(rowId),
    ],
  });
}

/** 승인·질문이 등록됐다(POST /api/reply/ask). 세션 행이 아직 없으면 세션이 생길 때(wait 전환) 알린다. */
export function notifyRequest(deps: NotifyDeps, requestId: string): void {
  deps.telegram.enqueue('승인·질문 알림', async (bot) => {
    const [r] = await deps.sql<RequestRow[]>`
      SELECT id, session_id, kind, tool_name, tool_input, questions, session_allow
      FROM reply_requests WHERE id = ${requestId} AND status = 'pending'`;
    if (!r) return;
    const s = await loadSession(deps.sql, r.session_id);
    if (!s || s.status === 'end' || !s.telegram) return;
    const target = await loadTarget(deps.sql, s.user_id);
    if (!target?.settings.wait) return;
    if (await requestNotified(deps.sql, r.id)) return;
    await sendRequest(deps, bot, s, r, target);
  });
  deps.push.enqueue('승인·질문 웹 알림', async () => {
    const [r] = await deps.sql<RequestRow[]>`
      SELECT id, session_id, kind, tool_name, tool_input, questions, session_allow
      FROM reply_requests WHERE id = ${requestId} AND status = 'pending'`;
    if (!r) return;
    const s = await loadSession(deps.sql, r.session_id);
    if (!s || s.status === 'end' || !s.telegram) return;
    if (!(await loadPushSettings(deps.sql, s.user_id))?.wait) return;
    await pushRequest(deps, s, r);
  });
}

/** 승인·질문 웹 알림(같은 요청은 한 번만). */
async function pushRequest(deps: NotifyDeps, s: SessionInfo, r: RequestRow): Promise<void> {
  if (!(await pushOnce(deps.sql, s.user_id, `req:${r.id}`, deps.now()))) return;
  await sendPush(deps, s.user_id, pushText.request(pushHeadOf(s), {
    kind: r.kind, toolName: r.tool_name, summary: summaryOf(r.tool_input, r.questions),
  }));
}

/** handleWait의 웹 푸시 쪽. */
async function handleWaitPush(deps: NotifyDeps, sessionId: string, text: string | undefined): Promise<void> {
  const s = await loadSession(deps.sql, sessionId);
  if (!s || s.status !== 'wait' || !s.telegram) return;
  if (!(await loadPushSettings(deps.sql, s.user_id))?.wait) return;
  const requests = await deps.sql<RequestRow[]>`
    SELECT id, session_id, kind, tool_name, tool_input, questions, session_allow
    FROM reply_requests WHERE session_id = ${sessionId} AND status = 'pending' ORDER BY created_at, id`;
  if (requests.length > 0) {
    for (const r of requests) await pushRequest(deps, s, r);
    return;
  }
  if (!deps.push.throttle(`${sessionId}:wait`, deps.now())) return;
  await sendPush(deps, s.user_id, pushText.wait(pushHeadOf(s), text ?? s.activity_text ?? ''));
}

/** 세션이 wait가 됐다. 기다리는 승인·질문이 있으면 그것을(아직 안 알렸으면), 없으면 일반 알림을 보낸다. */
async function handleWait(deps: NotifyDeps, bot: TelegramBot, sessionId: string, text: string | undefined): Promise<void> {
  const s = await loadSession(deps.sql, sessionId);
  if (!s || s.status !== 'wait' || !s.telegram) return;
  const target = await loadTarget(deps.sql, s.user_id);
  if (!target?.settings.wait) return;
  const requests = await deps.sql<RequestRow[]>`
    SELECT id, session_id, kind, tool_name, tool_input, questions, session_allow
    FROM reply_requests WHERE session_id = ${sessionId} AND status = 'pending' ORDER BY created_at, id`;
  if (requests.length > 0) {
    for (const r of requests) {
      if (await requestNotified(deps.sql, r.id)) continue;
      await sendRequest(deps, bot, s, r, target);
    }
    return;
  }
  if (!deps.telegram.throttle(`${sessionId}:wait`, deps.now())) return;
  await sendTracked(deps, bot, {
    userId: s.user_id, chatId: target.chatId, sessionId, html: waitText(headOf(deps, s), text ?? s.activity_text ?? ''),
    keyboard: muteRow,
  });
}

// ── 상태 바뀜(끝남·끊김·기다림) ──────────────────────────

/** 수집·끊김 판정에서 바뀐 세션 상태들을 알린다. */
export function notifySessionChanges(deps: NotifyDeps, changes: StatusChange[]): void {
  for (const c of changes) {
    if (c.to === 'wait') {
      deps.telegram.later(deps.telegram.waitGraceMs, '기다림 알림', (bot) => handleWait(deps, bot, c.sessionId, c.text));
      deps.push.later(deps.push.waitGraceMs, '기다림 웹 알림', () => handleWaitPush(deps, c.sessionId, c.text));
    } else if (c.to === 'done' || c.to === 'lost') {
      const kind = c.to;
      deps.push.enqueue(kind === 'done' ? '끝남 웹 알림' : '끊김 웹 알림', async () => {
        const s = await loadSession(deps.sql, c.sessionId);
        if (!s || s.status !== kind || !s.telegram) return;
        if (!(await loadPushSettings(deps.sql, s.user_id))?.[kind]) return;
        if (!deps.push.throttle(`${c.sessionId}:${kind}`, deps.now())) return;
        const text = c.text ?? s.activity_text ?? '';
        await sendPush(deps, s.user_id, kind === 'done' ? pushText.done(pushHeadOf(s), text) : pushText.lost(pushHeadOf(s), text));
      });
      deps.telegram.enqueue(kind === 'done' ? '끝남 알림' : '끊김 알림', async (bot) => {
        const s = await loadSession(deps.sql, c.sessionId);
        if (!s || s.status !== kind || !s.telegram) return;
        const target = await loadTarget(deps.sql, s.user_id);
        if (!target?.settings[kind]) return;
        if (!deps.telegram.throttle(`${c.sessionId}:${kind}`, deps.now())) return;
        const text = c.text ?? s.activity_text ?? '';
        await sendTracked(deps, bot, {
          userId: s.user_id, chatId: target.chatId, sessionId: s.id,
          html: kind === 'done' ? doneText(headOf(deps, s), text, s.can_reply) : lostText(headOf(deps, s), text),
          keyboard: muteRow,
        });
      });
    }
  }
}

// ── 한도 ────────────────────────────────────────────────

/** 새 한도 기록이 들어왔다. 5시간·주간이 기준을 처음 넘으면(그 창이 초기화되기 전에는 한 번만) 알린다. */
export function notifyLimits(deps: NotifyDeps, userId: string, l: LimitSnapshot): void {
  deps.push.enqueue('한도 웹 알림', async () => {
    const settings = await loadPushSettings(deps.sql, userId);
    if (!settings?.limit) return;
    const pct = settings.limitPct;
    const [acct] = await deps.sql<{ alias: string | null }[]>`
      SELECT alias FROM accounts WHERE user_id = ${userId} AND email = ${l.account}`;
    const windows = [
      { win: 'five' as const, pct: l.fiveHourPct, resets: l.fiveHourResetsAt },
      { win: 'seven' as const, pct: l.sevenDayPct, resets: l.sevenDayResetsAt },
    ];
    for (const w of windows) {
      if (w.pct < pct) continue;
      if (!(await pushOnce(deps.sql, userId, `limit:${l.account}:${w.win}:${w.resets ?? 0}`, deps.now()))) continue;
      await sendPush(deps, userId, pushText.limit({
        account: acct?.alias ? `${acct.alias} (${l.account})` : l.account, window: w.win, pct: w.pct, limitPct: pct,
      }));
    }
  });
  if (!deps.telegram.bot) return;
  deps.telegram.enqueue('한도 알림', async (bot) => {
    const target = await loadTarget(deps.sql, userId);
    if (!target?.settings.limit) return;
    const pct = target.settings.limitPct;
    const [acct] = await deps.sql<{ alias: string | null }[]>`
      SELECT alias FROM accounts WHERE user_id = ${userId} AND email = ${l.account}`;
    const windows = [
      { win: 'five' as const, pct: l.fiveHourPct, resets: l.fiveHourResetsAt },
      { win: 'seven' as const, pct: l.sevenDayPct, resets: l.sevenDayResetsAt },
    ];
    for (const w of windows) {
      if (w.pct < pct) continue;
      const fresh = await deps.sql`
        INSERT INTO limit_alerts (user_id, account, win, resets_at, created_at)
        VALUES (${userId}, ${l.account}, ${w.win}, ${w.resets ?? 0}, ${deps.now()})
        ON CONFLICT DO NOTHING RETURNING win`;
      if (fresh.length === 0) continue;
      await sendTracked(deps, bot, {
        userId, chatId: target.chatId, sessionId: null,
        html: limitText(deps.config.publicUrl, {
          account: acct?.alias ? `${acct.alias} (${l.account})` : l.account,
          window: w.win, pct: w.pct, limitPct: pct, resetsAt: w.resets,
        }),
      });
    }
  });
}

// ── 가입 신청 ───────────────────────────────────────────

/** 가입 신청(동의를 마친 pending 사용자)이 생겼다 → 텔레그램을 연결한 관리자와 웹 푸시를 구독한 관리자 모두에게. */
export function notifySignup(deps: NotifyDeps, user: { email: string; name: string | null }): void {
  deps.push.enqueue('가입 신청 웹 알림', async () => {
    const admins = await deps.sql<{ id: string }[]>`
      SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND delete_at IS NULL`;
    for (const a of admins) await sendPush(deps, a.id, pushText.signup(user));
  });
  if (!deps.telegram.bot) return;
  deps.telegram.enqueue('가입 신청 알림', async (bot) => {
    const admins = await deps.sql<{ user_id: string; chat_id: string }[]>`
      SELECT l.user_id, l.chat_id FROM telegram_links l JOIN users u ON u.id = l.user_id
      WHERE u.role = 'admin' AND u.status = 'active' AND u.delete_at IS NULL`;
    for (const a of admins) {
      try {
        await sendTracked(deps, bot, {
          userId: a.user_id, chatId: Number(a.chat_id), sessionId: null, html: signupText(deps.config.publicUrl, user),
        });
      } catch (err) {
        // 한 관리자에게 실패해도 나머지에게는 보낸다.
        console.error('[telegram] 가입 신청 알림 실패:', errorLine(err, bot.token));
      }
    }
  });
}

// ── 저장 용량 정리 ──────────────────────────────────────

/** 저장 용량 한도를 넘어 오래된 대화를 지웠다 → 그 사용자에게(항목 설정과 상관없이). */
export function notifyTrim(deps: NotifyDeps, userId: string, t: { lines: number; quotaMb: number }): void {
  deps.push.enqueue('용량 정리 웹 알림', async () => {
    await sendPush(deps, userId, pushText.trim(t));
  });
  if (!deps.telegram.bot) return;
  deps.telegram.enqueue('용량 정리 알림', async (bot) => {
    const target = await loadTarget(deps.sql, userId);
    if (!target) return;
    await sendTracked(deps, bot, { userId, chatId: target.chatId, sessionId: null, html: trimText(deps.config.publicUrl, t) });
  });
}
