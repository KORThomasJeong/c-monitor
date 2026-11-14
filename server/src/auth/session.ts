// 로그인 세션(쿠키 cm_session ↔ DB web_sessions)과 OAuth 상태값 쿠키.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Config, Q, User } from '../types';
import { sha256Hex } from '../util';

export const SESSION_COOKIE = 'cm_session';
export const OAUTH_COOKIE = 'cm_oauth';
export const SESSION_DAYS = 30;
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;
const OAUTH_SECONDS = 10 * 60;

const isSecure = (config: Config) => config.publicUrl.startsWith('https://');

type UserRow = { id: string; email: string; name: string | null; role: User['role']; status: User['status'] };
export const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, name: r.name, role: r.role, status: r.status });

/** 로그인 세션을 만들고 쿠키에 넣을 토큰 원문을 돌려준다(DB에는 해시만). */
export async function createWebSession(sql: Q, userId: string, now: Date): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(now.getTime() + SESSION_SECONDS * 1000);
  await sql`INSERT INTO web_sessions (id, user_id, expires_at) VALUES (${sha256Hex(token)}, ${userId}, ${expires})`;
  return token;
}

export async function findUserBySessionToken(sql: Q, token: string, now: Date): Promise<User | null> {
  const [row] = await sql<UserRow[]>`
    SELECT u.id, u.email, u.name, u.role, u.status
    FROM web_sessions w JOIN users u ON u.id = w.user_id
    WHERE w.id = ${sha256Hex(token)} AND w.expires_at > ${now}`;
  return row ? toUser(row) : null;
}

export async function deleteWebSession(sql: Q, token: string): Promise<void> {
  await sql`DELETE FROM web_sessions WHERE id = ${sha256Hex(token)}`;
}

export function setSessionCookie(c: Context, config: Config, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'Lax', secure: isSecure(config), path: '/', maxAge: SESSION_SECONDS,
  });
}

export function clearSessionCookie(c: Context, config: Config): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: isSecure(config) });
}

export const readSessionCookie = (c: Context): string | undefined => getCookie(c, SESSION_COOKIE);

// ── OAuth 상태값 쿠키: state.verifier.next(base64url).서명 ──────────────

export type OAuthState = { state: string; verifier: string; next: string };

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function newOAuthState(next: string): OAuthState {
  return {
    state: randomBytes(16).toString('base64url'),
    verifier: randomBytes(32).toString('base64url'),
    next,
  };
}

export function setOAuthCookie(c: Context, config: Config, s: OAuthState): void {
  const payload = `${s.state}.${s.verifier}.${Buffer.from(s.next, 'utf8').toString('base64url')}`;
  setCookie(c, OAUTH_COOKIE, `${payload}.${sign(config.sessionSecret, payload)}`, {
    httpOnly: true, sameSite: 'Lax', secure: isSecure(config), path: '/auth', maxAge: OAUTH_SECONDS,
  });
}

export function readOAuthCookie(c: Context, config: Config): OAuthState | null {
  const raw = getCookie(c, OAUTH_COOKIE);
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const [state, verifier, next, mac] = parts as [string, string, string, string];
  const expected = Buffer.from(sign(config.sessionSecret, `${state}.${verifier}.${next}`));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { state, verifier, next: Buffer.from(next, 'base64url').toString('utf8') };
}

export function clearOAuthCookie(c: Context, config: Config): void {
  deleteCookie(c, OAUTH_COOKIE, { path: '/auth', secure: isSecure(config) });
}

/** 로그인 뒤 돌아갈 곳. 같은 사이트 안의 경로만 허용한다(오픈 리디렉션 방지). */
export function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/';
  if (/[\u0000-\u001f]/.test(next)) return '/';
  return next;
}
