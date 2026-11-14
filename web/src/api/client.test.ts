import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from './client';

type Call = { url: string; init: RequestInit };
let calls: Call[];
let reply: () => Response;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  reply = () => json(200, {});
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return reply();
  }));
  window.history.replaceState(null, '', '/');
});
afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('쿠키를 함께 보내고 JSON을 돌려준다', async () => {
    reply = () => json(200, { user: { id: 'u1', email: 'a@gmail.com' } });
    const me = await api.getMe();
    expect(me.user.email).toBe('a@gmail.com');
    expect(calls[0]?.url).toBe('/api/me');
    expect(calls[0]?.init.credentials).toBe('include');
  });

  it('경로와 메서드가 계약과 같다', async () => {
    await api.getDashboard();
    await api.getLog('s/1', { after: 7 });
    await api.getLog('s2');
    await api.getLog('s2', { before: 100 });
    await api.getLog('s2', { around: 42 });
    await api.searchLog('s/1', '푸시 해');
    await api.deleteSession('s/1');
    await api.lookupDevice('K7QM-2XPA');
    await api.denyDevice('K7QM-2XPA');
    await api.markSeen('s/1');
    await api.approveDevice('K7QM-2XPA');
    await api.getSettings();
    await api.putSettings({ lostMinutes: 10, endHours: 24, keepChatDays: 30, keepUsageDays: 90 });
    await api.patchAccount('dev@company-a.example', { alias: '회사' });
    await api.revokeMachine('m1');
    await api.getAdminUsers();
    await api.approveUser('u1');
    await api.suspendUser('u1');
    await api.logout();
    expect(calls.map((c) => `${c.init.method ?? 'GET'} ${c.url}`)).toEqual([
      'GET /api/sessions',
      'GET /api/sessions/s%2F1/log?after=7',
      'GET /api/sessions/s2/log',
      'GET /api/sessions/s2/log?before=100',
      'GET /api/sessions/s2/log?around=42',
      'GET /api/sessions/s%2F1/search?q=%ED%91%B8%EC%8B%9C%20%ED%95%B4&limit=50',
      'DELETE /api/sessions/s%2F1',
      'GET /api/device/lookup?code=K7QM-2XPA',
      'POST /api/device/deny',
      'POST /api/sessions/s%2F1/seen',
      'POST /api/device/approve',
      'GET /api/settings',
      'PUT /api/settings',
      'PATCH /api/accounts/dev%40company-a.example',
      'DELETE /api/machines/m1',
      'GET /api/admin/users',
      'POST /api/admin/users/u1/approve',
      'POST /api/admin/users/u1/suspend',
      'POST /auth/logout',
    ]);
    const bodyOf = (sig: string) => JSON.parse(String(calls.find((c) => `${c.init.method ?? 'GET'} ${c.url}` === sig)?.init.body));
    expect(bodyOf('POST /api/device/approve')).toEqual({ userCode: 'K7QM-2XPA' });
    expect(bodyOf('POST /api/device/deny')).toEqual({ userCode: 'K7QM-2XPA' });
    expect(bodyOf('PATCH /api/accounts/dev%40company-a.example')).toEqual({ alias: '회사' });
  });

  it('원격 답장: 답 보내기와 컴퓨터 스위치의 경로·본문', async () => {
    reply = () => json(200, { ok: true, queued: true });
    const res = await api.replyToSession('s/1', { type: 'message', text: '안녕하세요' });
    expect(res).toEqual({ ok: true, queued: true });
    await api.patchMachine('m 1', { remoteReply: false });
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual(['POST /api/sessions/s%2F1/reply', 'PATCH /api/machines/m%201']);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ type: 'message', text: '안녕하세요' });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ remoteReply: false });
  });

  it('알림(텔레그램): 경로·메서드·본문이 계약과 같다', async () => {
    const settings = { wait: true, done: false, lost: true, limit: true, limitPct: 90 };
    await api.getNotify();
    await api.putNotifySettings(settings);
    await api.createTelegramLink();
    await api.unlinkTelegram();
    await api.sendTelegramTest();
    await api.patchSession('s/1', { telegram: false });
    await api.getAdminTelegram();
    await api.putAdminTelegram('12345:abc');
    await api.deleteAdminTelegram();
    expect(calls.map((c) => `${c.init.method ?? 'GET'} ${c.url}`)).toEqual([
      'GET /api/notify',
      'PUT /api/notify/settings',
      'POST /api/notify/telegram/link',
      'DELETE /api/notify/telegram',
      'POST /api/notify/telegram/test',
      'PATCH /api/sessions/s%2F1',
      'GET /api/admin/telegram',
      'PUT /api/admin/telegram',
      'DELETE /api/admin/telegram',
    ]);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual(settings);
    expect(calls[2]!.init.body).toBeUndefined();
    expect(JSON.parse(String(calls[5]!.init.body))).toEqual({ telegram: false });
    expect(JSON.parse(String(calls[7]!.init.body))).toEqual({ token: '12345:abc' });
  });

  it('답장 실패 문구: 409 no_pending·reply_disabled를 구분한다', async () => {
    reply = () => json(409, { error: 'no_pending' });
    const e1 = await api.replyToSession('s1', { type: 'permission', requestId: 'r1', behavior: 'allow' }).catch((e) => e);
    expect(api.errorCode(e1)).toBe('no_pending');
    expect(api.replyErrorText(e1)).toBe('이미 터미널에서 답했습니다');
    reply = () => json(409, { error: 'reply_disabled' });
    const e2 = await api.replyToSession('s1', { type: 'message', text: 'x' }).catch((e) => e);
    expect(api.replyErrorText(e2)).toBe('이 컴퓨터는 원격 답장이 꺼져 있습니다');
    expect(api.replyErrorText(new api.ApiError(404, { error: 'not_found' }))).toBe('세션을 찾지 못했습니다');
    expect(api.replyErrorText(new TypeError('network'))).toBe('보내지 못했습니다. 잠시 뒤 다시 시도해 주세요');
  });

  it('관리자 사용자 목록은 배열이든 {users}든 배열로 돌려준다', async () => {
    reply = () => json(200, { users: [{ id: 'u1' }] });
    expect(await api.getAdminUsers()).toEqual([{ id: 'u1' }]);
    reply = () => json(200, [{ id: 'u2' }]);
    expect(await api.getAdminUsers()).toEqual([{ id: 'u2' }]);
  });

  it('401이면 로그인 화면으로 보내고 오류를 던진다', async () => {
    window.history.replaceState(null, '', '/connect?code=AB12-CD34');
    reply = () => json(401, { error: 'unauthorized' });
    await expect(api.getDashboard()).rejects.toMatchObject({ status: 401 });
    expect(window.location.pathname).toBe('/login');
    expect(new URLSearchParams(window.location.search).get('next')).toBe('/connect?code=AB12-CD34');
  });

  it('403 pending이면 승인 대기 화면으로 보낸다', async () => {
    reply = () => json(403, { error: 'pending' });
    await expect(api.getDashboard()).rejects.toMatchObject({ status: 403 });
    expect(window.location.pathname).toBe('/pending');
  });

  it('403 pending이어도 돌아갈 주소(next)를 잃지 않는다', async () => {
    window.history.replaceState(null, '', '/connect?code=AB12-CD34');
    reply = () => json(403, { error: 'pending' });
    await expect(api.getMe()).rejects.toMatchObject({ status: 403 });
    expect(window.location.pathname).toBe('/pending');
    expect(new URLSearchParams(window.location.search).get('next')).toBe('/connect?code=AB12-CD34');
  });

  it('pending이 아닌 403은 화면을 옮기지 않는다', async () => {
    reply = () => json(403, { error: 'forbidden' });
    await expect(api.getAdminUsers()).rejects.toMatchObject({ status: 403 });
    expect(window.location.pathname).toBe('/');
  });

  it('본문이 없는 성공 응답도 처리한다', async () => {
    reply = () => new Response(null, { status: 204 });
    await expect(api.markSeen('a')).resolves.toBeUndefined();
  });
});
