import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MeResponse } from '@c-monitor/shared';
import { ADMIN, makeHarness, makeTestDb, type TestDb } from './helpers';

let db: TestDb;
let h: ReturnType<typeof makeHarness>;
beforeAll(async () => { db = await makeTestDb(); h = makeHarness(db); });
afterAll(async () => { await db.drop(); });

describe('구글 로그인·가입', () => {
  it('로그인 시작은 구글로 보내고 상태값 쿠키를 심는다', async () => {
    const res = await h.req('GET', '/auth/google');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^https:\/\/google\.test\/auth\?state=/);
    expect(h.cookieFrom(res, 'cm_oauth')).toBeTruthy();
  });

  it('ADMIN_EMAILS의 이메일은 첫 로그인에 active+admin이 된다', async () => {
    const cookie = await h.login(ADMIN);
    const res = await h.req('GET', '/api/me', { cookie });
    expect(res.status).toBe(200);
    const me = (await res.json()) as MeResponse;
    expect(me.user).toMatchObject({ email: ADMIN, role: 'admin', status: 'active' });
    expect(typeof me.pendingCount).toBe('number');
  });

  it('그 외 이메일은 pending이고 /api/me만 된다', async () => {
    const cookie = await h.login('new@example.com');
    const me = (await (await h.req('GET', '/api/me', { cookie })).json()) as MeResponse;
    expect(me.user).toMatchObject({ email: 'new@example.com', role: 'user', status: 'pending' });
    expect(me.pendingCount).toBeUndefined();
    expect((await h.req('GET', '/api/sessions', { cookie })).status).toBe(403);
    expect((await h.req('GET', '/api/settings', { cookie })).status).toBe(403);
    expect((await h.req('GET', '/api/stream', { cookie })).status).toBe(403);
  });

  it('로그인하지 않으면 401', async () => {
    expect((await h.req('GET', '/api/me')).status).toBe(401);
    expect((await h.req('GET', '/api/sessions')).status).toBe(401);
    expect((await h.req('GET', '/api/me', { cookie: 'cm_session=nope' })).status).toBe(401);
  });

  it('상태값이 맞지 않으면 콜백을 거부한다', async () => {
    const start = await h.req('GET', '/auth/google');
    const oauth = h.cookieFrom(start, 'cm_oauth')!;
    const res = await h.req('GET', '/auth/google/callback?code=x@example.com&state=wrong', { cookie: oauth });
    expect(res.status).toBe(400);
    expect(h.cookieFrom(res, 'cm_session')).toBeNull();
    const noCookie = await h.req('GET', '/auth/google/callback?code=x@example.com&state=abc');
    expect(noCookie.status).toBe(400);
  });

  it('로그인 쿠키는 httpOnly·SameSite=Lax·Secure이고 DB에는 해시만 남는다', async () => {
    const start = await h.req('GET', '/auth/google');
    const oauth = h.cookieFrom(start, 'cm_oauth')!;
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cb = await h.req('GET', `/auth/google/callback?code=${ADMIN}&state=${state}`, { cookie: oauth });
    expect(cb.status).toBe(302);
    const line = cb.headers.getSetCookie().find((l) => l.startsWith('cm_session='))!;
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=Lax/i);
    expect(line).toMatch(/Secure/i);
    expect(line).toMatch(/Max-Age=2592000/);
    const value = line.split(';')[0]!.slice('cm_session='.length);
    const ids = (await db.sql<{ id: string }[]>`SELECT id FROM web_sessions`).map((r) => r.id);
    expect(ids).not.toContain(value);
    expect(ids).toContain(createHash('sha256').update(value).digest('hex'));
  });

  it('로그인 뒤 돌아갈 곳(next)은 같은 사이트 경로만 허용한다', async () => {
    const go = async (next: string) => {
      const start = await h.req('GET', `/auth/google?next=${encodeURIComponent(next)}`);
      const oauth = h.cookieFrom(start, 'cm_oauth')!;
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
      const cb = await h.req('GET', `/auth/google/callback?code=${ADMIN}&state=${state}`, { cookie: oauth });
      return cb.headers.get('location');
    };
    expect(await go('/connect?code=ABCD-EFGH')).toBe('/connect?code=ABCD-EFGH');
    expect(await go('https://evil.test/')).toBe('/');
    expect(await go('//evil.test/')).toBe('/');
  });

  it('로그아웃하면 세션이 사라진다', async () => {
    const cookie = await h.login(ADMIN);
    expect((await h.req('POST', '/auth/logout', { cookie })).status).toBe(200);
    expect((await h.req('GET', '/api/me', { cookie })).status).toBe(401);
  });
});

describe('가입 승인', () => {
  it('관리자가 승인하면 쓸 수 있고, 정지하면 다시 막힌다', async () => {
    const admin = await h.login(ADMIN);
    const cookie = await h.login('join@example.com');
    const id = await h.userId('join@example.com');

    const list = (await (await h.req('GET', '/api/admin/users', { cookie: admin })).json()) as {
      users: { id: string; email: string; status: string }[];
    };
    expect(list.users.find((u) => u.id === id)).toMatchObject({ email: 'join@example.com', status: 'pending' });

    const me = (await (await h.req('GET', '/api/me', { cookie: admin })).json()) as MeResponse;
    expect(me.pendingCount).toBeGreaterThanOrEqual(1);

    expect((await h.req('POST', `/api/admin/users/${id}/approve`, { cookie: admin })).status).toBe(200);
    expect((await h.req('GET', '/api/sessions', { cookie })).status).toBe(200);

    expect((await h.req('POST', `/api/admin/users/${id}/suspend`, { cookie: admin })).status).toBe(200);
    expect((await h.req('GET', '/api/sessions', { cookie })).status).toBe(403);
    expect((await h.req('GET', '/api/me', { cookie })).status).toBe(200);
  });

  it('일반 사용자는 관리자 API를 쓸 수 없다', async () => {
    const { cookie, id } = await h.activeUser('plain@example.com');
    expect((await h.req('GET', '/api/admin/users', { cookie })).status).toBe(403);
    expect((await h.req('POST', `/api/admin/users/${id}/approve`, { cookie })).status).toBe(403);
    expect((await h.req('GET', '/api/admin/users')).status).toBe(401);
  });

  it('관리자는 자기 자신을 정지할 수 없고, 없는 사용자는 404', async () => {
    const admin = await h.login(ADMIN);
    const id = await h.userId(ADMIN);
    expect((await h.req('POST', `/api/admin/users/${id}/suspend`, { cookie: admin })).status).toBe(400);
    expect((await h.req('POST', '/api/admin/users/none/approve', { cookie: admin })).status).toBe(404);
  });
});
