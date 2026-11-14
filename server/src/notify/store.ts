// 봇 토큰 저장·불러오기와 화면에 내려 줄 뷰.
import { NOTIFY_DEFAULTS, type AdminTelegramView, type NotifySettings, type NotifyView } from '@c-monitor/shared';
import type { Deps, Q } from '../types';
import { settingsFromRow, type NotifyRow } from './notify';
import { decryptSecret } from './secret';
import { errorLine } from './telegram';

type BotRow = { token_enc: string; token_hint: string; bot_username: string; updated_at: Date };

export async function loadBotRow(sql: Q): Promise<BotRow | null> {
  const [r] = await sql<BotRow[]>`SELECT token_enc, token_hint, bot_username, updated_at FROM telegram_bot WHERE id = 1`;
  return r ?? null;
}

/** 서버 시작 때: DB에 토큰이 있으면 받기 루프를 시작한다. → 시작했으면 true. */
export async function startBotFromDb(deps: Deps): Promise<boolean> {
  const row = await loadBotRow(deps.sql);
  if (!row) return false;
  const token = decryptSecret(row.token_enc, deps.config.sessionSecret);
  if (!token) {
    console.error('[telegram] 저장된 봇 토큰을 풀지 못했습니다(SESSION_SECRET이 바뀌었나요?). 관리 화면에서 토큰을 다시 넣어 주세요.');
    return false;
  }
  try {
    await deps.telegram.start(deps, { client: deps.telegramClient(token), username: row.bot_username, token });
  } catch (err) {
    console.error('[telegram] 봇 시작 실패:', errorLine(err, token));
    return false;
  }
  return true;
}

export async function adminTelegramView(deps: Deps): Promise<AdminTelegramView> {
  const row = await loadBotRow(deps.sql);
  const [count] = await deps.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM telegram_links`;
  const st = deps.telegram.status();
  return {
    configured: row !== null,
    botUsername: row?.bot_username ?? null,
    tokenHint: row?.token_hint ?? null,
    updatedAt: row ? row.updated_at.toISOString() : null,
    polling: deps.telegram.bot ? st.polling : 'off',
    lastError: deps.telegram.bot ? st.lastError : null,
    linkedUsers: count?.n ?? 0,
  };
}

export async function loadNotifySettings(sql: Q, userId: string): Promise<NotifySettings> {
  const [r] = await sql<NotifyRow[]>`
    SELECT notify_wait, notify_done, notify_lost, notify_limit, notify_limit_pct FROM settings WHERE user_id = ${userId}`;
  return r ? settingsFromRow(r) : { ...NOTIFY_DEFAULTS };
}

export async function notifyView(deps: Deps, userId: string): Promise<NotifyView> {
  const [link] = await deps.sql<{ name: string | null; linked_at: Date }[]>`
    SELECT name, linked_at FROM telegram_links WHERE user_id = ${userId}`;
  const bot = deps.telegram.bot;
  return {
    telegram: {
      available: bot !== null,
      botUsername: bot?.username ?? null,
      linked: link !== undefined,
      linkedName: link?.name ?? null,
      linkedAt: link ? link.linked_at.toISOString() : null,
    },
    settings: await loadNotifySettings(deps.sql, userId),
  };
}
