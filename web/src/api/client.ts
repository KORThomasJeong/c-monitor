// 서버 API 호출. 쿠키 로그인 기준이며 401·403(pending)은 알맞은 화면으로 보낸다.
import {
  API,
  SEARCH_LIMIT,
  type DashboardSnapshot,
  type LogResponse,
  type LogSearchResponse,
  type MachineView,
  type MeResponse,
  type ReplyRequest,
  type ReplyResponse,
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

/** 지금 주소를 돌아갈 곳(?next=)으로 붙인다. 대시보드·로그인·대기 화면이면 붙이지 않는다. */
export function nextQuery(here = window.location.pathname + window.location.search): string {
  if (here === '/' || here.startsWith('/login') || here.startsWith('/pending')) return '';
  return `?next=${encodeURIComponent(here)}`;
}

function toLogin() {
  if (window.location.pathname === '/login') return;
  navigate(`/login${nextQuery()}`, { replace: true });
}

function toPending() {
  if (window.location.pathname === '/pending') return;
  navigate(`/pending${nextQuery()}`, { replace: true });
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
    else if (res.status === 403 && isPendingBody(data)) toPending();
    throw new ApiError(res.status, data);
  }
  return data as T;
}

const enc = encodeURIComponent;
const sessionPath = (id: string) => `${API.sessions}/${enc(id)}`;

export const getMe = () => request<MeResponse>('GET', API.me);
export const getDashboard = () => request<DashboardSnapshot>('GET', API.sessions);

/** 대화 한 쪽(기본 100줄). 기준을 주지 않으면 가장 최근 줄들. */
export type LogCursor = { before: number } | { after: number } | { around: number };

export function getLog(sessionId: string, cursor?: LogCursor) {
  const q = cursor ? `?${Object.entries(cursor).map(([k, v]) => `${k}=${v}`).join('&')}` : '';
  return request<LogResponse>('GET', `${sessionPath(sessionId)}/log${q}`);
}

/** 세션 전체 대화에서 찾는다(최신 줄부터). */
export const searchLog = (sessionId: string, q: string, limit = SEARCH_LIMIT) =>
  request<LogSearchResponse>('GET', `${sessionPath(sessionId)}/search?q=${enc(q)}&limit=${limit}`);

/** 종료·연락 끊김 세션과 그 대화 기록을 지운다. */
export const deleteSession = (sessionId: string) => request<{ ok: true }>('DELETE', sessionPath(sessionId));

export const markSeen = (sessionId: string) => request<void>('POST', `${sessionPath(sessionId)}/seen`);

/** 응답 본문은 계약에 없다. 서버가 machineName을 주면 성공 화면에 쓴다. */
export const approveDevice = (userCode: string) =>
  request<{ machineName?: string } | undefined>('POST', API.deviceApprove, { userCode });

/** 연결 확인 화면에 보일 컴퓨터 정보. 없거나 만료·이미 처리된 코드면 404. */
export const lookupDevice = (userCode: string) =>
  request<{ userCode: string; machineName: string; os: string }>('GET', `/api/device/lookup?code=${enc(userCode)}`);

/** 연결 요청을 거부한다. 404면 이미 처리된 요청. */
export const denyDevice = (userCode: string) => request<{ ok: true }>('POST', '/api/device/deny', { userCode });

export const getSettings = () => request<SettingsView>('GET', API.settings);
export const putSettings = (s: SettingsView) => request<SettingsView | undefined>('PUT', API.settings, s);

export const patchAccount = (email: string, patch: { alias?: string | null; hidden?: boolean }) =>
  request<void>('PATCH', `/api/accounts/${enc(email)}`, patch);

export const revokeMachine = (id: string) => request<void>('DELETE', `/api/machines/${enc(id)}`);

/** 컴퓨터별 원격 답장 스위치. 응답 본문은 계약에 없어 바뀐 컴퓨터를 줄 수도, 비어 있을 수도 있다. */
export const patchMachine = (id: string, patch: { remoteReply: boolean }) =>
  request<MachineView | { ok: true } | undefined>('PATCH', `/api/machines/${enc(id)}`, patch);

/**
 * 세션에 답하거나 글을 보낸다(확인 창 없이 바로).
 * 409 no_pending = 이미 끝난 승인·질문, 409 reply_disabled = 원격 답장을 쓸 수 없는 세션.
 */
export const replyToSession = (sessionId: string, body: ReplyRequest) =>
  request<ReplyResponse>('POST', `${sessionPath(sessionId)}/reply`, body);

/** 오류 응답 본문의 코드({error} 또는 {code}). */
export function errorCode(e: unknown): string | null {
  if (!(e instanceof ApiError) || !e.body || typeof e.body !== 'object') return null;
  const b = e.body as Record<string, unknown>;
  const c = b.error ?? b.code;
  return typeof c === 'string' ? c : null;
}

/** 답장 실패를 화면에 보일 짧은 문구로. */
export function replyErrorText(e: unknown): string {
  const code = errorCode(e);
  if (code === 'no_pending') return '이미 터미널에서 답했습니다';
  if (code === 'reply_disabled') return '이 컴퓨터는 원격 답장이 꺼져 있습니다';
  if (e instanceof ApiError && e.status === 404) return '세션을 찾지 못했습니다';
  if (e instanceof ApiError && e.status === 400) return '보낼 수 없는 내용입니다';
  return '보내지 못했습니다. 잠시 뒤 다시 시도해 주세요';
}

/** 서버가 배열이나 {users: [...]} 어느 쪽으로 줘도 배열로 돌려준다. */
export async function getAdminUsers(): Promise<UserView[]> {
  const data = await request<UserView[] | { users: UserView[] }>('GET', API.adminUsers);
  return Array.isArray(data) ? data : (data?.users ?? []);
}
export const approveUser = (id: string) => request<void>('POST', `${API.adminUsers}/${enc(id)}/approve`);
export const suspendUser = (id: string) => request<void>('POST', `${API.adminUsers}/${enc(id)}/suspend`);

export const logout = () => request<void>('POST', '/auth/logout');
