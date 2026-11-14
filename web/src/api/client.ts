// 서버 API 호출. 쿠키 로그인 기준이며 401·403(pending)은 알맞은 화면으로 보낸다.
import {
  API,
  type DashboardSnapshot,
  type LogResponse,
  type MeResponse,
  type SettingsView,
  type UserView,
} from '@c-monitor/shared';
import { navigate } from '../router';

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`API ${status}`);
    this.name = 'ApiError';
  }
}

/** 403 응답이 "승인 대기" 뜻인지. 서버가 {error:'pending'}(또는 code/status)로 알려 준다고 본다. */
function isPendingBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return b.error === 'pending' || b.code === 'pending' || b.status === 'pending';
}

function toLogin() {
  const here = window.location.pathname + window.location.search;
  if (window.location.pathname === '/login') return;
  const next = here === '/' ? '' : `?next=${encodeURIComponent(here)}`;
  navigate(`/login${next}`, { replace: true });
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'include', headers: { accept: 'application/json' } };
  if (body !== undefined) {
    init.headers = { ...init.headers, 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    if (res.status === 401) toLogin();
    else if (res.status === 403 && isPendingBody(data)) navigate('/pending', { replace: true });
    throw new ApiError(res.status, data);
  }
  return data as T;
}

const enc = encodeURIComponent;
const sessionPath = (id: string) => `${API.sessions}/${enc(id)}`;

export const getMe = () => request<MeResponse>('GET', API.me);
export const getDashboard = () => request<DashboardSnapshot>('GET', API.sessions);

export const getLog = (sessionId: string, after?: number) =>
  request<LogResponse>('GET', `${sessionPath(sessionId)}/log${after != null ? `?after=${after}` : ''}`);

export const markSeen = (sessionId: string) => request<void>('POST', `${sessionPath(sessionId)}/seen`);

/** 응답 본문은 계약에 없다. 서버가 machineName을 주면 성공 화면에 쓴다. */
export const approveDevice = (userCode: string) =>
  request<{ machineName?: string } | undefined>('POST', API.deviceApprove, { userCode });

export const getSettings = () => request<SettingsView>('GET', API.settings);
export const putSettings = (s: SettingsView) => request<SettingsView | undefined>('PUT', API.settings, s);

export const patchAccount = (email: string, patch: { alias?: string | null; hidden?: boolean }) =>
  request<void>('PATCH', `/api/accounts/${enc(email)}`, patch);

export const revokeMachine = (id: string) => request<void>('DELETE', `/api/machines/${enc(id)}`);

/** 서버가 배열이나 {users: [...]} 어느 쪽으로 줘도 배열로 돌려준다. */
export async function getAdminUsers(): Promise<UserView[]> {
  const data = await request<UserView[] | { users: UserView[] }>('GET', API.adminUsers);
  return Array.isArray(data) ? data : (data?.users ?? []);
}
export const approveUser = (id: string) => request<void>('POST', `${API.adminUsers}/${enc(id)}/approve`);
export const suspendUser = (id: string) => request<void>('POST', `${API.adminUsers}/${enc(id)}/suspend`);

export const logout = () => request<void>('POST', '/auth/logout');
