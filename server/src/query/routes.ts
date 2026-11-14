// 조회 API: 대시보드 목록, 대화 로그, 봤음 표시, 계정 별칭, 기기 폐기, 설정.
import { Hono } from 'hono';
import { z } from 'zod';
import type { LogResponse, SettingsView } from '@c-monitor/shared';
import { requireUser, userGuard } from '../auth/guard';
import type { Deps, Env, User } from '../types';
import { fail, readBody } from '../util';
import { loadAccountViews, loadLog, loadSessionViews, loadSettings, loadSnapshot } from './views';

const LOG_LIMIT_DEFAULT = 5000;
const LOG_LIMIT_MAX = 20000;

const AccountPatchSchema = z.object({
  alias: z.string().trim().max(60).nullable().optional(),
  hidden: z.boolean().optional(),
}).strict();

const SettingsSchema = z.object({
  lostMinutes: z.number().int().min(1).max(1440),
  endHours: z.number().int().min(0).max(8760),
  keepChatDays: z.number().int().min(1).max(3650),
  keepUsageDays: z.number().int().min(1).max(3650),
}).partial().strict();

export function queryRoutes(deps: Deps): Hono<Env> {
  const { sql } = deps;
  const app = new Hono<Env>();
  const active = userGuard(deps, 'active');

  /** 세션 소유자를 확인한다. 남의 것이면(관리자 열람 제외) 없는 것처럼 404. */
  async function ownerOf(sessionId: string, user: User, allowAdmin: boolean): Promise<string> {
    const [row] = await sql<{ user_id: string }[]>`SELECT user_id FROM sessions WHERE id = ${sessionId}`;
    if (!row) throw fail(404, 'not_found');
    if (row.user_id !== user.id && !(allowAdmin && user.role === 'admin')) throw fail(404, 'not_found');
    return row.user_id;
  }

  app.get('/api/sessions', active, async (c) => {
    const user = requireUser(c);
    const target = c.req.query('user') || user.id;
    if (target !== user.id && user.role !== 'admin') throw fail(403, 'forbidden');
    const history = c.req.query('history') === '1';
    return c.json(await loadSnapshot(sql, target, deps.now(), { history }));
  });

  app.get('/api/sessions/:id/log', active, async (c) => {
    const id = c.req.param('id');
    await ownerOf(id, requireUser(c), true);
    const afterRaw = c.req.query('after');
    const after = afterRaw === undefined ? -1 : Number(afterRaw);
    if (!Number.isInteger(after)) throw fail(400, 'invalid_after');
    const limitRaw = Number(c.req.query('limit') ?? LOG_LIMIT_DEFAULT);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, LOG_LIMIT_MAX) : LOG_LIMIT_DEFAULT;
    const res: LogResponse = { lines: await loadLog(sql, id, after, limit) };
    return c.json(res);
  });

  app.post('/api/sessions/:id/seen', active, async (c) => {
    const id = c.req.param('id');
    const user = requireUser(c);
    await ownerOf(id, user, false);
    const changed = await sql`UPDATE sessions SET seen = true WHERE id = ${id} AND seen = false RETURNING id`;
    const [view] = await loadSessionViews(sql, [id]);
    if (changed.length > 0 && view) deps.bus.publish(user.id, { type: 'session', session: view.session });
    return c.json({ session: view!.session });
  });

  app.patch('/api/accounts/:email', active, async (c) => {
    const user = requireUser(c);
    const email = c.req.param('email');
    const body = await readBody(c, AccountPatchSchema);
    const alias = body.alias === undefined ? undefined : (body.alias || null);
    const rows = await sql`
      UPDATE accounts SET
        alias = ${alias === undefined ? sql`alias` : alias},
        hidden = ${body.hidden === undefined ? sql`hidden` : body.hidden}
      WHERE user_id = ${user.id} AND email = ${email} RETURNING email`;
    if (rows.length === 0) throw fail(404, 'not_found');
    const [account] = await loadAccountViews(sql, user.id, deps.now(), email);
    deps.bus.publish(user.id, { type: 'limits', account: account! });
    return c.json(account);
  });

  app.delete('/api/machines/:id', active, async (c) => {
    const user = requireUser(c);
    const now = deps.now();
    const rows = await sql`
      UPDATE machines SET revoked_at = ${now}
      WHERE id = ${c.req.param('id')} AND user_id = ${user.id} AND revoked_at IS NULL RETURNING id`;
    if (rows.length === 0) throw fail(404, 'not_found');
    // 목록에서 빠지는 변화는 스냅샷을 통째로 다시 보내 알린다.
    deps.bus.publish(user.id, { type: 'snapshot', ...(await loadSnapshot(sql, user.id, now)) });
    return c.json({ ok: true });
  });

  app.get('/api/settings', active, async (c) => {
    return c.json(await loadSettings(sql, requireUser(c).id));
  });

  app.put('/api/settings', active, async (c) => {
    const user = requireUser(c);
    const body = await readBody(c, SettingsSchema);
    const next: SettingsView = { ...(await loadSettings(sql, user.id)), ...body };
    await sql`
      INSERT INTO settings (user_id, lost_minutes, end_hours, keep_chat_days, keep_usage_days)
      VALUES (${user.id}, ${next.lostMinutes}, ${next.endHours}, ${next.keepChatDays}, ${next.keepUsageDays})
      ON CONFLICT (user_id) DO UPDATE SET
        lost_minutes = EXCLUDED.lost_minutes, end_hours = EXCLUDED.end_hours,
        keep_chat_days = EXCLUDED.keep_chat_days, keep_usage_days = EXCLUDED.keep_usage_days`;
    // 종료 카드 유지 시간이 바뀌면 보이는 목록도 달라진다.
    if (body.endHours !== undefined) {
      deps.bus.publish(user.id, { type: 'snapshot', ...(await loadSnapshot(sql, user.id, deps.now())) });
    }
    return c.json(next);
  });

  return app;
}
