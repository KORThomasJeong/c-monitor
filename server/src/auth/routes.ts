// 구글 로그인, 로그아웃, 내 정보, 가입 고지 동의, 탈퇴·탈퇴 취소, 내 저장 용량.
// 관리자 API는 admin/routes.ts.
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { MeResponse, StorageMe } from '@c-monitor/shared';
import { userBytes } from '../account/storage';
import { purgeUser, restoreUser, withdrawUser } from '../account/users';
import { notifySignup } from '../notify/notify';
import type { Deps, Env, User } from '../types';
import { fail } from '../util';
import { requireUser, userGuard } from './guard';
import {
  clearOAuthCookie, clearSessionCookie, createWebSession, deleteWebSession, newOAuthState,
  readOAuthCookie, readSessionCookie, safeNext, setOAuthCookie, setSessionCookie, toUser, type UserRow,
} from './session';


/**
 * 구글 로그인에 성공한 이메일로 사용자를 찾거나 만든다. created는 이번에 새로 만들었는가.
 * - ADMIN_EMAILS의 이메일은 관리자·승인됨
 * - 관리자가 미리 추가한(invited) 사용자는 이미 승인돼 있다 — 첫 로그인 때 invited를 지운다
 * - 삭제 예정 시각이 지난 탈퇴 사용자는 (매일 정리가 돌기 전이라도) 지우고 새로 가입시킨다
 */
export async function upsertUser(
  deps: Pick<Deps, 'sql' | 'bus' | 'now' | 'reply'>, adminEmails: string[], emailRaw: string, name: string | null,
): Promise<{ user: User; created: boolean }> {
  const { sql } = deps;
  const now = deps.now();
  const email = emailRaw.trim().toLowerCase();
  const isAdmin = adminEmails.includes(email);
  const [expired] = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE email = ${email} AND delete_at IS NOT NULL AND delete_at <= ${now}`;
  if (expired) await purgeUser(deps, expired.id);

  const [created] = await sql<UserRow[]>`
    INSERT INTO users (id, email, name, role, status, last_login_at)
    VALUES (${randomUUID()}, ${email}, ${name}, ${isAdmin ? 'admin' : 'user'}, ${isAdmin ? 'active' : 'pending'}, ${now})
    ON CONFLICT (email) DO NOTHING
    RETURNING id, email, name, role, status, consented_at, delete_at`;
  if (created) return { user: toUser(created), created: true };
  // 이미 있는 사용자: 나중에 ADMIN_EMAILS에 추가된 경우 관리자로 올린다.
  const [row] = isAdmin
    ? await sql<UserRow[]>`
        UPDATE users SET role = 'admin', status = 'active', name = COALESCE(${name}, name), invited = false, last_login_at = ${now}
        WHERE email = ${email} RETURNING id, email, name, role, status, consented_at, delete_at`
    : await sql<UserRow[]>`
        UPDATE users SET name = COALESCE(${name}, name), invited = false, last_login_at = ${now}
        WHERE email = ${email} RETURNING id, email, name, role, status, consented_at, delete_at`;
  return { user: toUser(row!), created: false };
}

/** 승인을 기다리는(동의를 마치고 탈퇴하지 않은) 가입 신청 수. */
async function pendingCount(deps: Pick<Deps, 'sql'>): Promise<number> {
  const [row] = await deps.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM users WHERE status = 'pending' AND consented_at IS NOT NULL AND delete_at IS NULL`;
  return row?.n ?? 0;
}

async function meResponse(deps: Deps, userId: string): Promise<MeResponse> {
  const [row] = await deps.sql<UserRow[]>`SELECT id, email, name, role, status, consented_at, delete_at FROM users WHERE id = ${userId}`;
  if (!row) throw fail(401, 'unauthorized');
  const user = toUser(row);
  const body: MeResponse = { user };
  if (user.role === 'admin' && user.status === 'active' && !user.deleteAt) body.pendingCount = await pendingCount(deps);
  return body;
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
    // 가입 신청 알림은 여기서 보내지 않는다 — 가입 고지에 동의할 때(POST /api/me/consent) 보낸다.
    const { user } = await upsertUser(deps, config.adminEmails, profile.email, profile.name);
    setSessionCookie(c, config, await createWebSession(sql, user.id, deps.now()));
    return c.redirect(safeNext(saved.next), 302);
  });

  app.post('/auth/logout', async (c) => {
    const token = readSessionCookie(c);
    if (token) await deleteWebSession(sql, token);
    clearSessionCookie(c, config);
    return c.json({ ok: true });
  });

  // 탈퇴 중이어도 볼 수 있다(웹이 "탈퇴 취소" 화면을 보여 주려고).
  app.get('/api/me', userGuard(deps, 'any', { allowWithdrawn: true }), async (c) => {
    return c.json(await meResponse(deps, requireUser(c).id));
  });

  // 가입 고지 동의. 처음 동의할 때 승인 대기 사용자면 관리자에게 가입 신청을 알린다.
  app.post('/api/me/consent', userGuard(deps, 'any'), async (c) => {
    const user = requireUser(c);
    const [row] = await sql<UserRow[]>`
      UPDATE users SET consented_at = ${deps.now()} WHERE id = ${user.id} AND consented_at IS NULL
      RETURNING id, email, name, role, status, consented_at, delete_at`;
    if (row && row.status === 'pending') notifySignup(deps, { email: row.email, name: row.name });
    return c.json(await meResponse(deps, user.id));
  });

  // 탈퇴: 즉시 거의 모든 API·기기 전송·공유 링크를 막고 WITHDRAW_DAYS 뒤 완전 삭제. 이미 탈퇴 중이면 그대로 돌려준다.
  app.post('/api/me/withdraw', userGuard(deps, 'any', { allowWithdrawn: true }), async (c) => {
    const user = requireUser(c);
    await withdrawUser(deps, user.id);
    return c.json(await meResponse(deps, user.id));
  });

  // 탈퇴 취소(삭제 예정 시각 전에만). 기기 연결도 그대로 되살아난다.
  app.post('/api/me/restore', userGuard(deps, 'any', { allowWithdrawn: true }), async (c) => {
    const user = requireUser(c);
    const result = await restoreUser(deps, user.id);
    if (result === 'expired') throw fail(409, 'expired');
    if (result === 'not_found') throw fail(401, 'unauthorized');
    return c.json(await meResponse(deps, user.id));
  });

  app.get('/api/me/storage', userGuard(deps, 'active'), async (c) => {
    const user = requireUser(c);
    const [row] = await sql<{ quota_mb: number; trimmed_at: Date | null }[]>`
      SELECT quota_mb, trimmed_at FROM users WHERE id = ${user.id}`;
    const bytes = (await userBytes(sql, [user.id])).get(user.id) ?? 0;
    return c.json<StorageMe>({
      bytes, quotaMb: row?.quota_mb ?? 0, trimmedAt: row?.trimmed_at ? row.trimmed_at.toISOString() : null,
    });
  });

  return app;
}
