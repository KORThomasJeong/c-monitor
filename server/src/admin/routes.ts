// 관리자 API: 사용자(목록·승인·정지·미리 추가·권한/한도·탈퇴 취소·즉시 삭제), 모든 컴퓨터, 저장 용량.
// 계약: shared/src/contract.ts "관리자". 텔레그램 봇 토큰은 notify/routes.ts.
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  AdminUserCreateSchema, AdminUserPatchSchema, DEFAULT_QUOTA_MB, MachinePatchSchema,
  type AdminMachineView, type AdminUserView,
} from '@c-monitor/shared';
import { adminStorage, diskFreeBytes } from '../account/storage';
import { loadAdminUsers, purgeUser, restoreUser } from '../account/users';
import { requireUser, userGuard } from '../auth/guard';
import { setRemoteReply } from '../device/remote';
import { revokeMachine } from '../device/revoke';
import { ONLINE_MS } from '../query/views';
import type { Deps, Env } from '../types';
import { fail, readBody } from '../util';

type MachineRow = {
  id: string; name: string; os: string; plugin_version: string; last_seen_at: Date | null; remote_reply: boolean;
  owner_id: string; owner_email: string; account: string | null;
};

export function adminRoutes(deps: Deps): Hono<Env> {
  const { sql } = deps;
  const app = new Hono<Env>();
  const admin = userGuard(deps, 'admin');

  async function oneUser(id: string): Promise<AdminUserView> {
    const [view] = await loadAdminUsers(sql, [id]);
    if (!view) throw fail(404, 'not_found');
    return view;
  }

  async function loadMachines(id?: string): Promise<AdminMachineView[]> {
    const now = deps.now();
    const rows = await sql<MachineRow[]>`
      SELECT m.id, m.name, m.os, m.plugin_version, m.last_seen_at, m.remote_reply,
             m.user_id AS owner_id, u.email AS owner_email,
             (SELECT s.account FROM sessions s WHERE s.machine_id = m.id AND s.account IS NOT NULL
               ORDER BY s.last_event_at DESC LIMIT 1) AS account
      FROM machines m JOIN users u ON u.id = m.user_id
      WHERE m.revoked_at IS NULL ${id ? sql`AND m.id = ${id}` : sql``}
      ORDER BY m.last_seen_at DESC NULLS LAST, m.created_at, m.id`;
    return rows.map((r) => ({
      id: r.id, name: r.name, os: r.os, pluginVersion: r.plugin_version,
      lastSeenAt: r.last_seen_at ? r.last_seen_at.toISOString() : null,
      online: r.last_seen_at !== null && now.getTime() - r.last_seen_at.getTime() <= ONLINE_MS,
      remoteReply: r.remote_reply, ownerId: r.owner_id, ownerEmail: r.owner_email, account: r.account,
    }));
  }

  // ── 사용자 ──────────────────────────────────────────────

  app.get('/api/admin/users', admin, async (c) => c.json({ users: await loadAdminUsers(sql) }));

  // 미리 추가: 그 이메일은 첫 구글 로그인 때 승인 없이 바로 쓴다(가입 고지 동의는 받는다).
  app.post('/api/admin/users', admin, async (c) => {
    const body = await readBody(c, AdminUserCreateSchema);
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO users (id, email, name, role, status, invited, quota_mb)
      VALUES (${randomUUID()}, ${body.email}, ${null}, ${body.role}, 'active', true, ${DEFAULT_QUOTA_MB})
      ON CONFLICT (email) DO NOTHING RETURNING id`;
    if (!row) throw fail(409, 'exists');
    return c.json(await oneUser(row.id));
  });

  // 권한·용량 한도. 자기 자신의 관리자 권한은 내릴 수 없다.
  app.patch('/api/admin/users/:id', admin, async (c) => {
    const me = requireUser(c);
    const id = c.req.param('id');
    const body = await readBody(c, AdminUserPatchSchema);
    if (id === me.id && body.role === 'user') throw fail(400, 'cannot_demote_self');
    const rows = await sql`
      UPDATE users SET
        role = ${body.role === undefined ? sql`role` : body.role},
        quota_mb = ${body.quotaMb === undefined ? sql`quota_mb` : body.quotaMb}
      WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) throw fail(404, 'not_found');
    return c.json(await oneUser(id));
  });

  const setStatus = async (id: string, status: 'active' | 'suspended'): Promise<AdminUserView> => {
    const rows = await sql`UPDATE users SET status = ${status} WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) throw fail(404, 'not_found');
    return oneUser(id);
  };

  app.post('/api/admin/users/:id/approve', admin, async (c) => c.json({ user: await setStatus(c.req.param('id'), 'active') }));

  app.post('/api/admin/users/:id/suspend', admin, async (c) => {
    const id = c.req.param('id');
    if (id === requireUser(c).id) throw fail(400, 'cannot_suspend_self');
    return c.json({ user: await setStatus(id, 'suspended') });
  });

  // 탈퇴 취소(관리자는 삭제 예정 시각이 지났어도 아직 지워지지 않았으면 되살릴 수 있다).
  app.post('/api/admin/users/:id/restore', admin, async (c) => {
    const id = c.req.param('id');
    if ((await restoreUser(deps, id, { force: true })) === 'not_found') throw fail(404, 'not_found');
    return c.json(await oneUser(id));
  });

  // 즉시 완전 삭제. 자기 자신은 안 된다.
  app.delete('/api/admin/users/:id', admin, async (c) => {
    const id = c.req.param('id');
    if (id === requireUser(c).id) throw fail(400, 'cannot_delete_self');
    if (!(await purgeUser(deps, id))) throw fail(404, 'not_found');
    return c.json({ ok: true });
  });

  // ── 모든 컴퓨터 ─────────────────────────────────────────

  app.get('/api/admin/machines', admin, async (c) => c.json({ machines: await loadMachines() }));

  app.patch('/api/admin/machines/:id', admin, async (c) => {
    const id = c.req.param('id');
    const { remoteReply } = await readBody(c, MachinePatchSchema);
    const [m] = await loadMachines(id);
    if (!m) throw fail(404, 'not_found');
    if (!(await setRemoteReply(deps, m.ownerId, id, remoteReply))) throw fail(404, 'not_found');
    const [view] = await loadMachines(id);
    return c.json(view);
  });

  app.delete('/api/admin/machines/:id', admin, async (c) => {
    const id = c.req.param('id');
    const [m] = await loadMachines(id);
    if (!m || !(await revokeMachine(deps, m.ownerId, id))) throw fail(404, 'not_found');
    return c.json({ ok: true });
  });

  // ── 저장 용량 ───────────────────────────────────────────

  app.get('/api/admin/storage', admin, async (c) => c.json(await adminStorage(sql, deps.diskFree ?? diskFreeBytes)));

  return app;
}
