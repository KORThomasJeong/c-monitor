// 구글 로그인, 로그아웃, 내 정보, 관리자의 가입 승인.
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { MeResponse, UserView } from '@c-monitor/shared';
import { notifySignup } from '../notify/notify';
import type { Deps, Env, Q, User } from '../types';
import { fail } from '../util';
import { requireUser, userGuard } from './guard';
import {
  clearOAuthCookie, clearSessionCookie, createWebSession, deleteWebSession, newOAuthState,
  readOAuthCookie, readSessionCookie, safeNext, setOAuthCookie, setSessionCookie, toUser,
} from './session';

type UserRow = { id: string; email: string; name: string | null; role: User['role']; status: User['status']; created_at: Date };
export type AdminUserView = UserView & { createdAt: string };

/** 구글 로그인에 성공한 이메일로 사용자를 찾거나 만든다. created는 이번에 새로 만들었는가. */
export async function upsertUser(
  sql: Q, adminEmails: string[], emailRaw: string, name: string | null,
): Promise<{ user: User; created: boolean }> {
  const email = emailRaw.trim().toLowerCase();
  const isAdmin = adminEmails.includes(email);
  const [created] = await sql<UserRow[]>`
    INSERT INTO users (id, email, name, role, status)
    VALUES (${randomUUID()}, ${email}, ${name}, ${isAdmin ? 'admin' : 'user'}, ${isAdmin ? 'active' : 'pending'})
    ON CONFLICT (email) DO NOTHING
    RETURNING id, email, name, role, status, created_at`;
  if (created) return { user: toUser(created), created: true };
  // 이미 있는 사용자: 나중에 ADMIN_EMAILS에 추가된 경우 관리자로 올린다.
  const [row] = isAdmin
    ? await sql<UserRow[]>`
        UPDATE users SET role = 'admin', status = 'active', name = COALESCE(${name}, name)
        WHERE email = ${email} RETURNING id, email, name, role, status, created_at`
    : await sql<UserRow[]>`
        UPDATE users SET name = COALESCE(${name}, name)
        WHERE email = ${email} RETURNING id, email, name, role, status, created_at`;
  return { user: toUser(row!), created: false };
}

export function authRoutes(deps: Deps): Hono<Env> {
  const { sql, config } = deps;
  const app = new Hono<Env>();

  app.get('/auth/google', (c) => {
    const s = newOAuthState(safeNext(c.req.query('next')));
    setOAuthCookie(c, config, s);
    return c.redirect(deps.google.authUrl(s.state, s.verifier), 302);
  });

  app.get('/auth/google/callback', async (c) => {
    const saved = readOAuthCookie(c, config);
    clearOAuthCookie(c, config);
    const state = c.req.query('state');
    if (!saved || !state || state !== saved.state) throw fail(400, 'invalid_state');
    const code = c.req.query('code');
    if (!code) return c.redirect('/?login_error=denied', 302);

    let profile: { email: string; name: string | null };
    try {
      profile = await deps.google.exchange(code, saved.verifier);
    } catch (err) {
      console.error('[auth] 구글 로그인 실패:', err instanceof Error ? err.message : err);
      return c.redirect('/?login_error=failed', 302);
    }
    const { user, created } = await upsertUser(sql, config.adminEmails, profile.email, profile.name);
    // 새 가입 신청이면 관리자에게 텔레그램으로 알린다(비동기).
    if (created && user.status === 'pending') notifySignup(deps, user);
    setSessionCookie(c, config, await createWebSession(sql, user.id, deps.now()));
    return c.redirect(safeNext(saved.next), 302);
  });

  app.post('/auth/logout', async (c) => {
    const token = readSessionCookie(c);
    if (token) await deleteWebSession(sql, token);
    clearSessionCookie(c, config);
    return c.json({ ok: true });
  });

  app.get('/api/me', userGuard(deps, 'any'), async (c) => {
    const user = requireUser(c);
    const body: MeResponse = { user };
    if (user.role === 'admin' && user.status === 'active') {
      const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE status = 'pending'`;
      body.pendingCount = row?.n ?? 0;
    }
    return c.json(body);
  });

  // ── 관리자 ──────────────────────────────────────────────
  const toAdminView = (r: UserRow): AdminUserView => ({ ...toUser(r), createdAt: r.created_at.toISOString() });

  app.get('/api/admin/users', userGuard(deps, 'admin'), async (c) => {
    const rows = await sql<UserRow[]>`
      SELECT id, email, name, role, status, created_at FROM users
      ORDER BY (status = 'pending') DESC, created_at DESC`;
    return c.json({ users: rows.map(toAdminView) });
  });

  const setStatus = (status: 'active' | 'suspended') =>
    async (id: string): Promise<AdminUserView> => {
      const [row] = await sql<UserRow[]>`
        UPDATE users SET status = ${status} WHERE id = ${id}
        RETURNING id, email, name, role, status, created_at`;
      if (!row) throw fail(404, 'not_found');
      return toAdminView(row);
    };

  app.post('/api/admin/users/:id/approve', userGuard(deps, 'admin'), async (c) => {
    return c.json({ user: await setStatus('active')(c.req.param('id')) });
  });

  app.post('/api/admin/users/:id/suspend', userGuard(deps, 'admin'), async (c) => {
    const id = c.req.param('id');
    if (id === requireUser(c).id) throw fail(400, 'cannot_suspend_self');
    return c.json({ user: await setStatus('suspended')(id) });
  });

  return app;
}
