// 조회 API: 대시보드 목록, 대화 로그(페이지 단위)·검색, 봤음 표시, 세션 삭제, 계정 별칭, 기기 폐기, 설정.
import { Hono } from 'hono';
import { z } from 'zod';
import {
  DELETABLE_STATUSES, LOG_PAGE_MAX, LOG_PAGE_SIZE, SEARCH_LIMIT, SEARCH_MIN_CHARS,
  type SessionStatus, type SettingsView,
} from '@c-monitor/shared';
import { requireUser, userGuard } from '../auth/guard';
import { revokeMachine } from '../device/revoke';
import type { Deps, Env, User } from '../types';
import { fail, readBody } from '../util';
import { searchLog } from './search';
import { loadAccountViews, loadLogPage, loadSessionViews, loadSettings, loadSnapshot, type LogCursor } from './views';

/** 검색 결과 최대 개수와 검색어 최대 길이(글자 수). */
const SEARCH_LIMIT_MAX = 200;
const SEARCH_MAX_CHARS = 200;
/** seq는 DB에서 integer다. 이 범위를 벗어난 값은 받지 않는다. */
const SEQ_MAX = 2_147_483_647;

/** ?limit= 을 읽는다. 없으면 기본값, 숫자가 아니거나 1~max를 벗어나면 400. */
function readLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 1 && n <= max)) throw fail(400, 'invalid_limit');
  return n;
}

/** ?before= / ?after= / ?around= 중 하나를 읽는다. 둘 이상이거나 정수가 아니면 400. */
function readCursor(query: Record<string, string>): LogCursor {
  const given = (['before', 'after', 'around'] as const).filter((k) => query[k] !== undefined);
  if (given.length === 0) return null;
  const key = given[0]!;
  const raw = query[key]!;
  const n = /^-?\d{1,10}$/.test(raw) ? Number(raw) : NaN;
  if (given.length > 1 || !(Math.abs(n) <= SEQ_MAX)) throw fail(400, 'invalid_cursor');
  return key === 'before' ? { before: n } : key === 'after' ? { after: n } : { around: n };
}

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
    const cursor = readCursor(c.req.query());
    const limit = readLimit(c.req.query('limit'), LOG_PAGE_SIZE, LOG_PAGE_MAX);
    return c.json(await loadLogPage(sql, id, cursor, limit));
  });

  app.get('/api/sessions/:id/search', active, async (c) => {
    const id = c.req.param('id');
    await ownerOf(id, requireUser(c), true);
    const q = (c.req.query('q') ?? '').trim();
    const chars = Array.from(q).length;
    if (chars < SEARCH_MIN_CHARS || chars > SEARCH_MAX_CHARS) throw fail(400, 'invalid_query');
    const limit = readLimit(c.req.query('limit'), SEARCH_LIMIT, SEARCH_LIMIT_MAX);
    return c.json(await searchLog(sql, id, q, limit));
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

  // 종료·연락 끊김 세션을 소유자가 지운다. 남의 것은 관리자라도 없는 것처럼 404.
  app.delete('/api/sessions/:id', active, async (c) => {
    const id = c.req.param('id');
    const user = requireUser(c);
    const result = await sql.begin(async (tx): Promise<'not_found' | 'active' | 'deleted'> => {
      const [row] = await tx<{ user_id: string; machine_id: string; status: SessionStatus }[]>`
        SELECT user_id, machine_id, status FROM sessions WHERE id = ${id} FOR UPDATE`;
      if (!row || row.user_id !== user.id) return 'not_found';
      if (!DELETABLE_STATUSES.includes(row.status)) return 'active';
      await tx`DELETE FROM shares WHERE session_id = ${id}`;
      await tx`DELETE FROM transcript_lines WHERE session_id = ${id}`;
      await tx`DELETE FROM sessions WHERE id = ${id}`;
      // 지운 표시를 남긴다 — 늦게 도착한 옛 이벤트나 종료 알림으로 카드가 다시 생기지 않게(ingest/apply.ts).
      await tx`
        INSERT INTO deleted_sessions (session_id, machine_id, deleted_at) VALUES (${id}, ${row.machine_id}, ${deps.now()})
        ON CONFLICT (session_id) DO UPDATE SET deleted_at = EXCLUDED.deleted_at`;
      return 'deleted';
    });
    if (result === 'not_found') throw fail(404, 'not_found');
    if (result === 'active') throw fail(409, 'session_active');
    deps.bus.publish(user.id, { type: 'removed', sessionIds: [id] });
    return c.json({ ok: true });
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
    if (!(await revokeMachine(deps, requireUser(c).id, c.req.param('id')))) throw fail(404, 'not_found');
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
