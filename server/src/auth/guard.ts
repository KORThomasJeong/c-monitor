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
 * 탈퇴 중인 사용자(deleteAt 있음)는 allowWithdrawn을 켠 경로(/api/me·/api/me/restore 등)만 쓸 수 있고, 나머지는 403 withdrawn.
 */
export function userGuard(
  deps: Deps, level: 'any' | 'active' | 'admin' = 'active', opts: { allowWithdrawn?: boolean } = {},
): MiddlewareHandler<Env> {
  return async (c, next) => {
    const token = readSessionCookie(c);
    const user = token ? await findUserBySessionToken(deps.sql, token, deps.now()) : null;
    if (!user) throw fail(401, 'unauthorized');
    if (user.deleteAt && !opts.allowWithdrawn) throw fail(403, 'withdrawn');
    if (level !== 'any' && user.status !== 'active') throw fail(403, user.status);
    if (level === 'admin' && user.role !== 'admin') throw fail(403, 'forbidden');
    c.set('user', user);
    await next();
  };
}

/**
 * 기기 토큰(Authorization: Bearer)을 확인해 컨텍스트에 넣는다. 없거나 폐기됐으면 401.
 * 사용자가 탈퇴 중이면 403 withdrawn, active가 아니면 403 — 플러그인은 403이면 보낼 것을 큐에 남기고 기다린다
 * (탈퇴를 취소하면 그대로 이어진다). allowInactiveUser를 켜면 통과시킨다(연결 해제처럼 권한을 줄이기만 하는 요청용).
 */
export function machineGuard(deps: Deps, opts: { allowInactiveUser?: boolean } = {}): MiddlewareHandler<Env> {
  return async (c, next) => {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    if (!m) throw fail(401, 'unauthorized');
    const [row] = await deps.sql<{
      id: string; user_id: string; name: string; os: string; plugin_version: string;
      last_seen_at: Date | null; revoked_at: Date | null; remote_reply: boolean; user_status: User['status'];
      withdrawn: boolean;
    }[]>`
      SELECT m.id, m.user_id, m.name, m.os, m.plugin_version, m.last_seen_at, m.revoked_at, m.remote_reply,
             u.status AS user_status, u.delete_at IS NOT NULL AS withdrawn
      FROM machines m JOIN users u ON u.id = m.user_id
      WHERE m.token_hash = ${sha256Hex(m[1]!)}`;
    if (!row || row.revoked_at) throw fail(401, 'unauthorized');
    if (!opts.allowInactiveUser) {
      if (row.withdrawn) throw fail(403, 'withdrawn');
      if (row.user_status !== 'active') throw fail(403, row.user_status);
    }
    c.set('machine', {
      id: row.id, userId: row.user_id, name: row.name, os: row.os,
      pluginVersion: row.plugin_version, lastSeenAt: row.last_seen_at, remoteReply: row.remote_reply,
    });
    await next();
  };
}

export const requireUser = (c: Context<Env>): User => c.get('user');
export const requireMachine = (c: Context<Env>): Machine => c.get('machine');
