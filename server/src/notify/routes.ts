// 알림(텔레그램) API. 계약: shared/src/contract.ts "알림(텔레그램)".
//   로그인    GET /api/notify · PUT /api/notify/settings · POST /api/notify/telegram/link
//             DELETE /api/notify/telegram · POST /api/notify/telegram/test · PATCH /api/sessions/:id
//   관리자    GET·PUT·DELETE /api/admin/telegram
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import {
  AdminTelegramPutSchema, NotifySettingsSchema, SessionPatchSchema,
  type NotifySettings, type TelegramLinkResponse,
} from '@c-monitor/shared';
import { requireUser, userGuard } from '../auth/guard';
import { loadSessionViews } from '../query/views';
import type { Deps, Env } from '../types';
import { fail, parseJsonBody, readBody } from '../util';
import { TEST_TEXT } from './format';
import { encryptSecret } from './secret';
import { adminTelegramView, loadNotifySettings, notifyView } from './store';
import { errorLine, TelegramError } from './telegram';

/** 연결 코드 유효 시간(분)·글자 수·글자 모음(헷갈리는 0/O, 1/I 뺌). */
const LINK_CODE_MINUTES = 10;
const LINK_CODE_LENGTH = 8;
const LINK_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newLinkCode(): string {
  const bytes = randomBytes(LINK_CODE_LENGTH);
  return Array.from(bytes, (b) => LINK_CODE_ALPHABET[b % LINK_CODE_ALPHABET.length]).join('');
}

const SettingsPatchSchema = NotifySettingsSchema.partial().strict();

export function notifyRoutes(deps: Deps): Hono<Env> {
  const { sql } = deps;
  const app = new Hono<Env>();
  const active = userGuard(deps, 'active');
  const admin = userGuard(deps, 'admin');

  app.get('/api/notify', active, async (c) => c.json(await notifyView(deps, requireUser(c).id)));

  app.put('/api/notify/settings', active, async (c) => {
    const user = requireUser(c);
    const body = await readBody(c, SettingsPatchSchema);
    const next: NotifySettings = { ...(await loadNotifySettings(sql, user.id)), ...body };
    await sql`
      INSERT INTO settings (user_id, notify_wait, notify_done, notify_lost, notify_limit, notify_limit_pct)
      VALUES (${user.id}, ${next.wait}, ${next.done}, ${next.lost}, ${next.limit}, ${next.limitPct})
      ON CONFLICT (user_id) DO UPDATE SET
        notify_wait = EXCLUDED.notify_wait, notify_done = EXCLUDED.notify_done, notify_lost = EXCLUDED.notify_lost,
        notify_limit = EXCLUDED.notify_limit, notify_limit_pct = EXCLUDED.notify_limit_pct`;
    return c.json(await notifyView(deps, user.id));
  });

  // 연결 코드 받기. 새로 받으면 옛 코드는 무효(사용자마다 한 행).
  app.post('/api/notify/telegram/link', active, async (c) => {
    const user = requireUser(c);
    const bot = deps.telegram.bot;
    if (!bot) throw fail(409, 'telegram_unavailable');
    const expiresAt = new Date(deps.now().getTime() + LINK_CODE_MINUTES * 60_000);
    for (let attempt = 0; ; attempt++) {
      const code = newLinkCode();
      try {
        await sql`
          INSERT INTO telegram_link_codes (code, user_id, expires_at) VALUES (${code}, ${user.id}, ${expiresAt})
          ON CONFLICT (user_id) DO UPDATE SET code = EXCLUDED.code, expires_at = EXCLUDED.expires_at`;
      } catch (err) {
        // 다른 사용자의 코드와 겹쳤다(아주 드묾) — 새로 뽑는다.
        if (attempt < 3 && (err as { code?: string }).code === '23505') continue;
        throw err;
      }
      return c.json<TelegramLinkResponse>({
        code, url: `https://t.me/${bot.username}?start=${code}`, expiresAt: expiresAt.toISOString(),
      });
    }
  });

  app.delete('/api/notify/telegram', active, async (c) => {
    const user = requireUser(c);
    await sql`DELETE FROM telegram_links WHERE user_id = ${user.id}`;
    await sql`DELETE FROM telegram_link_codes WHERE user_id = ${user.id}`;
    return c.json(await notifyView(deps, user.id));
  });

  app.post('/api/notify/telegram/test', active, async (c) => {
    const user = requireUser(c);
    const bot = deps.telegram.bot;
    if (!bot) throw fail(409, 'telegram_unavailable');
    const [link] = await sql<{ chat_id: string }[]>`SELECT chat_id FROM telegram_links WHERE user_id = ${user.id}`;
    if (!link) throw fail(409, 'not_linked');
    try {
      await deps.telegram.call(() => bot.client.sendMessage({ chat_id: Number(link.chat_id), text: TEST_TEXT, parse_mode: 'HTML' }));
    } catch (err) {
      console.error('[telegram] 시험 메시지 실패:', errorLine(err, bot.token));
      throw fail(502, 'send_failed');
    }
    return c.json({ ok: true });
  });

  // 세션별 설정(지금은 텔레그램 스위치 하나). 소유자만 — 남의 것은 관리자라도 404.
  app.patch('/api/sessions/:id', active, async (c) => {
    const user = requireUser(c);
    const id = c.req.param('id');
    const { telegram } = await readBody(c, SessionPatchSchema);
    const rows = await sql`UPDATE sessions SET telegram = ${telegram} WHERE id = ${id} AND user_id = ${user.id} RETURNING id`;
    if (rows.length === 0) throw fail(404, 'not_found');
    const [view] = await loadSessionViews(sql, [id]);
    deps.bus.publish(user.id, { type: 'session', session: view!.session });
    return c.json({ session: view!.session });
  });

  // ── 관리자: 봇 토큰 ────────────────────────────────────

  app.get('/api/admin/telegram', admin, async (c) => c.json(await adminTelegramView(deps)));

  // getMe로 확인한 뒤 암호화해 저장하고, 받기 루프를 새 토큰으로 다시 시작한다.
  app.put('/api/admin/telegram', admin, async (c) => {
    const parsed = AdminTelegramPutSchema.safeParse(parseJsonBody(await c.req.text()));
    if (!parsed.success) throw fail(400, 'invalid_token');
    const token = parsed.data.token;
    const client = deps.telegramClient(token);
    let me: { username?: string };
    try {
      me = await client.getMe();
    } catch (err) {
      console.error('[telegram] 토큰 확인 실패:', errorLine(err, token));
      // 텔레그램이 거절했으면(401·404 등) 틀린 토큰, 그 밖(네트워크)은 연결 실패.
      if (err instanceof TelegramError) throw fail(400, 'invalid_token');
      throw fail(502, 'telegram_unreachable');
    }
    if (!me.username) throw fail(400, 'invalid_token');
    const username = me.username;
    const now = deps.now();
    await sql`
      INSERT INTO telegram_bot (id, token_enc, token_hint, bot_username, updated_at)
      VALUES (1, ${encryptSecret(token, deps.config.sessionSecret)}, ${token.slice(-4)}, ${username}, ${now})
      ON CONFLICT (id) DO UPDATE SET token_enc = EXCLUDED.token_enc, token_hint = EXCLUDED.token_hint,
        bot_username = EXCLUDED.bot_username, updated_at = EXCLUDED.updated_at`;
    await deps.telegram.start(deps, { client, username, token });
    return c.json(await adminTelegramView(deps));
  });

  // 봇 끄기 — 사용자 연결 정보는 남긴다(같은 봇을 다시 넣으면 그대로 이어진다).
  app.delete('/api/admin/telegram', admin, async (c) => {
    await deps.telegram.stop();
    await sql`DELETE FROM telegram_bot WHERE id = 1`;
    return c.json(await adminTelegramView(deps));
  });

  return app;
}
