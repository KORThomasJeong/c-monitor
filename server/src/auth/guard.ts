// 접근 검사: 로그인 사용자(쿠키)와 기기(Bearer 토큰).
import type { Context, MiddlewareHandler } from 'hono';
import type { Deps, Env, Machine, User } from '../types';
import { fail, sha256Hex } from '../util';
import { findUserBySessionToken, readSessionCookie } from './session';

/**
 * 로그인 사용자를 확인해 컨텍스트에 넣는다.
 * - any: 로그인만 되어 있으면 됨(/api/me)
 * - active: 승인된 사용자만(pending·suspended는 403)
 * - admin: 승인된 관리자만
 */
export function userGuard(deps: Deps, level: 'any' | 'active' | 'admin' = 'active'): MiddlewareHandler<Env> {
  return async (c, next) => {
    const token = readSessionCookie(c);
    const user = token ? await findUserBySessionToken(deps.sql, token, deps.now()) : null;
    if (!user) throw fail(401, 'unauthorized');
    if (level !== 'any' && user.status !== 'active') throw fail(403, user.status);
    if (level === 'admin' && user.role !== 'admin') throw fail(403, 'forbidden');
    c.set('user', user);
    await next();
  };
}

/**
 * 기기 토큰(Authorization: Bearer)을 확인해 컨텍스트에 넣는다. 없거나 폐기됐으면 401.
 * 사용자가 active가 아니면 403 — allowInactiveUser를 켜면 통과시킨다(연결 해제처럼 권한을 줄이기만 하는 요청용).
 */
export function machineGuard(deps: Deps, opts: { allowInactiveUser?: boolean } = {}): MiddlewareHandler<Env> {
  return async (c, next) => {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    if (!m) throw fail(401, 'unauthorized');
    const [row] = await deps.sql<{
      id: string; user_id: string; name: string; os: string; plugin_version: string;
      last_seen_at: Date | null; revoked_at: Date | null; user_status: User['status'];
    }[]>`
      SELECT m.id, m.user_id, m.name, m.os, m.plugin_version, m.last_seen_at, m.revoked_at, u.status AS user_status
      FROM machines m JOIN users u ON u.id = m.user_id
      WHERE m.token_hash = ${sha256Hex(m[1]!)}`;
    if (!row || row.revoked_at) throw fail(401, 'unauthorized');
    if (row.user_status !== 'active' && !opts.allowInactiveUser) throw fail(403, row.user_status);
    c.set('machine', {
      id: row.id, userId: row.user_id, name: row.name, os: row.os,
      pluginVersion: row.plugin_version, lastSeenAt: row.last_seen_at,
    });
    await next();
  };
}

export const requireUser = (c: Context<Env>): User => c.get('user');
export const requireMachine = (c: Context<Env>): Machine => c.get('machine');
