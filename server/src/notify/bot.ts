// 봇이 받은 업데이트 처리: /start <코드>·/stop, 알림의 버튼(승인·선택지·알림 끄기), 알림에 답장한 글.
// 답은 웹과 같은 submitReply를 쓴다 — 채팅에 연결된 사용자가 그 세션의 소유자여야 한다.
import { MESSAGE_MAX_CHARS, type ReplyQuestion, type ReplyRequest } from '@c-monitor/shared';
import { publishSessions } from '../query/views';
import { submitReply, type SubmitResult } from '../reply/answer';
import type { Deps } from '../types';
import { cleanText } from '../util';
import { MUTE_LABEL, resultLine } from './format';
import type { TelegramBot } from './hub';
import { errorLine, type InlineKeyboard, type TgCallbackQuery, type TgMessage, type TgUpdate, type TgUser } from './telegram';

/** 답장으로 세션을 찾을 수 있는 기간(telegram_messages 보관 기간과 같다). */
export const MESSAGE_KEEP_DAYS = 7;

const HELP_UNLINKED = 'c-monitor 설정 › 알림에서 연결 코드를 받아 <code>/start 코드</code> 를 보내 주세요.';
const HELP_LINKED = '알림 메시지에 <b>답장</b>으로 글을 쓰면 그 세션으로 보냅니다. 연결을 끊으려면 /stop 을 보내 주세요.';

export async function handleUpdate(deps: Deps, update: TgUpdate): Promise<void> {
  const bot = deps.telegram.bot;
  if (!bot) return;
  if (update.callback_query) return onCallback(deps, bot, update.callback_query);
  const msg = update.message;
  if (!msg || typeof msg.text !== 'string') return;
  // 그룹·채널에 연결하면 알림이 여러 사람에게 보인다 — 개인 채팅만 받는다.
  if (msg.chat.type !== 'private') return;
  const say = (html: string) => deps.telegram.call(() => bot.client.sendMessage({ chat_id: msg.chat.id, text: html, parse_mode: 'HTML' }));

  const text = cleanText(msg.text).trim();
  const cmd = /^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
  const command = cmd?.[1]?.toLowerCase();
  if (command === 'start') return void (await say(await linkChat(deps, msg, (cmd?.[2] ?? '').trim())));
  if (command === 'stop') {
    const gone = await deps.sql`DELETE FROM telegram_links WHERE chat_id = ${msg.chat.id} RETURNING user_id`;
    return void (await say(gone.length > 0 ? '연결을 끊었습니다. 더는 알림을 보내지 않습니다.' : '연결되어 있지 않습니다.'));
  }

  const userId = await linkedUser(deps, msg.chat.id);
  if (!userId) return void (await say(HELP_UNLINKED));
  if (msg.reply_to_message) return void (await say(await replyToSession(deps, userId, msg.chat.id, msg.reply_to_message.message_id, text)));
  await say(HELP_LINKED);
}

async function linkedUser(deps: Deps, chatId: number): Promise<string | null> {
  // 승인된(active) 사용자만 — 정지·대기 중인 사용자는 웹처럼 텔레그램으로도 답할 수 없다.
  const [r] = await deps.sql<{ user_id: string }[]>`
    SELECT l.user_id FROM telegram_links l JOIN users u ON u.id = l.user_id
    WHERE l.chat_id = ${chatId} AND u.status = 'active'`;
  return r?.user_id ?? null;
}

/** 연결된 텔레그램 계정의 표시 이름: @아이디, 없으면 이름. */
function displayName(u: TgUser | undefined): string | null {
  if (!u) return null;
  if (u.username) return `@${u.username}`;
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
  return name || null;
}

/** /start <코드> — 코드가 맞으면 그 사용자와 이 채팅을 잇는다(다른 사용자에 이어져 있던 채팅이면 옮긴다). */
async function linkChat(deps: Deps, msg: TgMessage, rawCode: string): Promise<string> {
  if (!rawCode) {
    return (await linkedUser(deps, msg.chat.id)) ? `이미 연결되어 있습니다. ${HELP_LINKED}` : HELP_UNLINKED;
  }
  const code = rawCode.toUpperCase();
  const now = deps.now();
  const result = await deps.sql.begin(async (tx): Promise<'ok' | 'wrong' | 'expired' | 'inactive'> => {
    // 1회용: 맞든 만료됐든 쓰면 지운다.
    const [c] = await tx<{ user_id: string; expires_at: Date; status: string }[]>`
      DELETE FROM telegram_link_codes c USING users u
      WHERE c.code = ${code} AND u.id = c.user_id
      RETURNING c.user_id, c.expires_at, u.status`;
    if (!c) return 'wrong';
    if (c.expires_at <= now) return 'expired';
    if (c.status !== 'active') return 'inactive';
    await tx`DELETE FROM telegram_links WHERE chat_id = ${msg.chat.id} OR user_id = ${c.user_id}`;
    await tx`
      INSERT INTO telegram_links (user_id, chat_id, name, linked_at)
      VALUES (${c.user_id}, ${msg.chat.id}, ${displayName(msg.from)}, ${now})`;
    return 'ok';
  });
  switch (result) {
    case 'ok': return '✅ 연결되었습니다. 이제 이 채팅으로 c-monitor 알림이 옵니다.';
    case 'expired': return '연결 코드가 만료되었습니다. 설정 화면에서 새 코드를 받아 주세요.';
    case 'inactive': return '승인된 계정이 아니라 연결할 수 없습니다.';
    default: return `연결 코드가 맞지 않습니다. ${HELP_UNLINKED}`;
  }
}

type MessageRow = {
  id: string; chat_id: string; message_id: string | null; session_id: string | null; request_id: string | null;
  html: string; keyboard: InlineKeyboard | null;
};

/** 결과에 맞는 짧은 안내(버튼 알림·답장 응답에 함께 쓴다). */
function failText(error: Exclude<SubmitResult, { ok: true }>['error']): string {
  switch (error) {
    case 'no_pending': return '이미 터미널에서 답했습니다';
    case 'not_found': return '이 세션에 답할 수 없습니다';
    case 'reply_disabled': return '지금은 원격으로 답할 수 없습니다(원격 답장 꺼짐 또는 세션 끝남)';
    default: return '이 선택은 쓸 수 없습니다';
  }
}

/** 알림에 답장한 글 → 그 세션으로. 승인 대기 중이면 거부+글, 질문 대기 중이면 첫 질문의 답, 아니면 새 글. */
async function replyToSession(deps: Deps, userId: string, chatId: number, messageId: number, text: string): Promise<string> {
  const [row] = await deps.sql<{ session_id: string }[]>`
    SELECT session_id FROM telegram_messages
    WHERE chat_id = ${chatId} AND message_id = ${messageId} AND session_id IS NOT NULL
      AND created_at > ${deps.now()}::timestamptz - make_interval(days => ${MESSAGE_KEEP_DAYS})`;
  if (!row) return '이 메시지로는 세션을 찾지 못했습니다. 세션 알림 메시지에 답장해 주세요.';
  if (!text) return '보낼 글이 비어 있습니다.';
  if (text.length > MESSAGE_MAX_CHARS) return `글이 너무 깁니다(최대 ${MESSAGE_MAX_CHARS}자).`;

  const [pending] = await deps.sql<{ id: string; kind: 'permission' | 'question'; questions: ReplyQuestion[] | null }[]>`
    SELECT id, kind, questions FROM reply_requests
    WHERE session_id = ${row.session_id} AND status = 'pending' ORDER BY created_at, id LIMIT 1`;
  const q0 = pending?.questions?.[0];
  const body: ReplyRequest = pending?.kind === 'permission'
    ? { type: 'permission', requestId: pending.id, behavior: 'deny', message: text }
    : pending?.kind === 'question' && q0
      ? { type: 'answer', requestId: pending.id, answers: { [q0.question]: text } }
      : { type: 'message', text };
  const res = await submitReply(deps, userId, row.session_id, body);
  if (!res.ok) return `${failText(res.error)}.`;
  if (body.type === 'permission') return '거부하고 글을 클로드에게 전했습니다.';
  if (body.type === 'answer') return '답을 보냈습니다.';
  return res.queued ? '보냈습니다. 세션이 지금 일을 끝내면 전달됩니다.' : '세션에 전달했습니다.';
}

/** 메시지를 결과 한 줄을 붙여 고쳐 쓴다. keyboard를 주지 않으면 버튼을 모두 없앤다. */
async function editResult(deps: Deps, bot: TelegramBot, row: MessageRow, line: string, keyboard: InlineKeyboard = []): Promise<void> {
  if (row.message_id === null) return;
  try {
    await deps.telegram.call(() => bot.client.editMessageText({
      chat_id: Number(row.chat_id), message_id: Number(row.message_id), text: row.html + resultLine(line), parse_mode: 'HTML',
      link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: keyboard },
    }));
    await deps.sql`UPDATE telegram_messages SET html = ${row.html + resultLine(line)}, keyboard = ${deps.sql.json(keyboard as never)} WHERE id = ${row.id}`;
  } catch (err) {
    console.error('[telegram] 메시지 고치기 실패:', errorLine(err, bot.token));
  }
}

const BEHAVIOR = { a: 'allow', s: 'allow_session', d: 'deny' } as const;
const DONE_LINE = { allow: '✓ 허용함', allow_session: '✓ 이 세션 동안 허용함', deny: '✗ 거부함' } as const;
const TOAST = { allow: '허용했습니다', allow_session: '이 세션 동안 허용했습니다', deny: '거부했습니다' } as const;

async function onCallback(deps: Deps, bot: TelegramBot, cq: TgCallbackQuery): Promise<void> {
  const toast = (text: string) => deps.telegram.call(() => bot.client.answerCallbackQuery({ callback_query_id: cq.id, text }))
    .catch((err) => console.error('[telegram] 버튼 응답 실패:', errorLine(err, bot.token)));
  const chatId = cq.message?.chat.id;
  const m = /^([pom]):(\d{1,18})(?::([a-z0-9]{1,3}))?$/.exec(cq.data ?? '');
  if (!m || chatId === undefined) return void (await toast('알 수 없는 버튼입니다'));
  const [, kind, rowId, arg] = m;

  const userId = await linkedUser(deps, chatId);
  if (!userId) return void (await toast('연결되지 않은 채팅입니다'));
  const [row] = await deps.sql<MessageRow[]>`
    SELECT id, chat_id, message_id, session_id, request_id, html, keyboard FROM telegram_messages
    WHERE id = ${rowId!} AND chat_id = ${chatId}`;
  if (!row || !row.session_id) return void (await toast('오래된 알림이라 처리할 수 없습니다'));

  if (kind === 'm') {
    // 이 세션 알림 끄기 — 소유자만.
    const off = await deps.sql`
      UPDATE sessions SET telegram = false WHERE id = ${row.session_id} AND user_id = ${userId} RETURNING id`;
    if (off.length === 0) return void (await toast('이 세션을 바꿀 수 없습니다'));
    await publishSessions(deps, [row.session_id]);
    await toast('이 세션 알림을 껐습니다');
    const rest = (row.keyboard ?? []).filter((r) => !r.some((b) => b.text === MUTE_LABEL));
    await editResult(deps, bot, row, '🔕 이 세션 알림을 껐습니다', rest);
    return;
  }

  if (!row.request_id) return void (await toast('알 수 없는 버튼입니다'));
  let body: ReplyRequest;
  let line: string;
  let done: string;
  if (kind === 'p') {
    const behavior = BEHAVIOR[arg as keyof typeof BEHAVIOR];
    if (!behavior) return void (await toast('알 수 없는 버튼입니다'));
    body = { type: 'permission', requestId: row.request_id, behavior };
    line = DONE_LINE[behavior];
    done = TOAST[behavior];
  } else {
    const [r] = await deps.sql<{ questions: ReplyQuestion[] | null }[]>`SELECT questions FROM reply_requests WHERE id = ${row.request_id}`;
    const q0 = r?.questions?.[0];
    const option = q0?.options[Number(arg)];
    if (!r) {
      await toast(failText('no_pending'));
      return void (await editResult(deps, bot, row, '— 이미 끝난 요청입니다'));
    }
    if (!q0 || !option) return void (await toast('알 수 없는 선택지입니다'));
    body = { type: 'answer', requestId: row.request_id, answers: { [q0.question]: option.label } };
    line = `✓ 답함: ${option.label}`;
    done = '답을 보냈습니다';
  }

  const res = await submitReply(deps, userId, row.session_id, body);
  if (res.ok) {
    await toast(done);
    await editResult(deps, bot, row, line);
  } else if (res.error === 'no_pending') {
    await toast(failText('no_pending'));
    await editResult(deps, bot, row, '— 이미 끝난 요청입니다');
  } else {
    await toast(failText(res.error));
  }
}
