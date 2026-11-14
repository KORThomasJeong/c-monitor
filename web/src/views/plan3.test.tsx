// 3차 웹 화면: 바로 열기, 기록 탭, 공유(창·공개 링크·공유받은 세션), 관리자 읽기 전용 보기,
// 동의·탈퇴, 저장 용량, 관리 화면, 웹 알림·소리, 컨텍스트·비용, 답 기록.
import {
  NOTIFY_DEFAULTS, type AdminMachineView, type AdminUserView, type DashboardSnapshot, type MeResponse, type NotifyView,
  type PendingView, type StreamMessage, type UserView,
} from '@c-monitor/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { connectStream, type StreamHandlers, type StreamOptions } from '../api/stream';
import { App } from '../App';
import { playChime } from '../lib/sound';
import { mkAccount, mkLine, mkMachine, mkSession } from '../test/fixtures';
import { AccountSection } from './Account';
import { AdminUsers } from './AdminUsers';
import { NotifySection } from './Notify';
import { Settings } from './Settings';

vi.mock('../api/stream', () => ({ connectStream: vi.fn() }));
vi.mock('../lib/sound', async (orig) => ({
  ...(await orig<typeof import('../lib/sound')>()),
  playChime: vi.fn(() => true),
}));
vi.mock('../api/client', async (orig) => {
  const real = await orig<typeof import('../api/client')>();
  const fns = [
    'getMe', 'getDashboard', 'getSettings', 'putSettings', 'patchAccount', 'revokeMachine', 'patchMachine', 'markSeen', 'getLog',
    'searchLog', 'deleteSession', 'getNotify', 'patchSession', 'replyToSession', 'getPushSubscriptions', 'getPushKey', 'pushSubscribe',
    'pushUnsubscribe', 'pushTest', 'getReplies', 'getHistory', 'getShares', 'createShare', 'deleteShare', 'getPublicSession',
    'getPublicLog', 'consent', 'withdraw', 'restoreMe', 'getMyStorage', 'getAdminUsers', 'createAdminUser', 'patchAdminUser',
    'restoreAdminUser', 'deleteAdminUser', 'getAdminMachines', 'patchAdminMachine', 'deleteAdminMachine', 'getAdminStorage',
    'getAdminTelegram', 'approveUser', 'suspendUser', 'logout',
  ] as const;
  return { ...real, ...Object.fromEntries(fns.map((f) => [f, vi.fn()])) };
});

let handlers: StreamHandlers<unknown>;
let streamOpts: StreamOptions | undefined;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const later = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

const userOf = (o: Partial<UserView> = {}): UserView => ({
  id: 'u1', email: 'admin@example.com', name: '관리자', role: 'admin', status: 'active',
  consentedAt: '2026-11-01T00:00:00Z', deleteAt: null, ...o,
});
const meOf = (o: Partial<UserView> = {}): MeResponse => ({ user: userOf(o) });
const adminRow = (o: Partial<AdminUserView> = {}): AdminUserView => ({
  ...userOf(o), createdAt: ago(60 * 24 * 10), lastLoginAt: ago(30), quotaMb: 1024, bytes: 300 * 1024 * 1024, machines: 2, invited: false, ...o,
});
const notifyOf = (tg: Partial<NotifyView['telegram']> = {}): NotifyView => ({
  telegram: { available: true, botUsername: 'c_monitor_test_bot', linked: true, linkedName: '@hong', linkedAt: null, ...tg },
  settings: NOTIFY_DEFAULTS,
});
const pendingAsk: PendingView = {
  id: 'req-1', kind: 'permission', toolName: 'Bash', summary: 'git push', sessionAllow: null, at: ago(1), more: 0,
};

type Snapshot = Extract<StreamMessage, { type: 'snapshot' }>;
const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  type: 'snapshot',
  machines: [mkMachine({ id: 'm1', name: '집 PC', os: 'Windows 11', pluginVersion: '0.3.0' })],
  accounts: [mkAccount({ email: 'dev@company-a.example' })],
  sessions: [
    mkSession({ id: 'run1', name: 'c-monitor', status: 'run', contextPct: 63.6, costUsd: 3.1234, startedAt: ago(12), lastEventAt: ago(0) }),
    mkSession({ id: 'wait1', name: 'search-api', status: 'wait', seen: false, pending: pendingAsk, canReply: true, startedAt: ago(42), lastEventAt: ago(1) }),
    mkSession({ id: 'end1', name: 'homepage', status: 'end', startedAt: ago(300), lastEventAt: ago(200), endedAt: ago(200) }),
    mkSession({ id: 'sh1', name: 'friend-repo', machineId: 'mx', status: 'end', sharedBy: 'friend@example.com', endedAt: ago(10) }),
    mkSession({ id: 'sh2', name: 'friend-live', machineId: 'mx', status: 'wait', sharedBy: 'friend@example.com', pending: pendingAsk, canReply: false }),
  ],
  ...over,
});

const emit = (msg: unknown) => act(() => { handlers.onStatus?.(true); handlers.onMessage(msg); });
const panel = () => screen.getByRole('complementary', { name: '세션 상세' });
const card = (name: RegExp) => screen.getByRole('button', { name });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  streamOpts = undefined;
  vi.mocked(connectStream).mockImplementation(((h: StreamHandlers<unknown>, o?: StreamOptions) => { handlers = h; streamOpts = o; return () => {}; }) as typeof connectStream);
  vi.mocked(api.getMe).mockResolvedValue(meOf());
  vi.mocked(api.getLog).mockResolvedValue({ lines: [], total: 0, hasMoreBefore: false, hasMoreAfter: false });
  vi.mocked(api.searchLog).mockResolvedValue({ hits: [], total: 0 });
  vi.mocked(api.markSeen).mockResolvedValue(undefined);
  vi.mocked(api.deleteSession).mockResolvedValue({ ok: true });
  vi.mocked(api.getNotify).mockResolvedValue(notifyOf());
  vi.mocked(api.getPushSubscriptions).mockResolvedValue([]);
  vi.mocked(api.getReplies).mockResolvedValue([]);
  vi.mocked(api.getHistory).mockResolvedValue({ sessions: [], machines: [], accounts: [] });
  vi.mocked(api.getShares).mockResolvedValue([]);
  vi.mocked(api.getAdminUsers).mockResolvedValue([]);
  vi.mocked(api.getMyStorage).mockResolvedValue({ bytes: 200 * 1024 * 1024, quotaMb: 1024, trimmedAt: null });
  vi.mocked(api.getSettings).mockResolvedValue({ lostMinutes: 10, endHours: 24, keepChatDays: 30, keepUsageDays: 90 });
  vi.mocked(api.getDashboard).mockResolvedValue({ sessions: [], machines: [], accounts: [] });
  vi.mocked(api.getAdminMachines).mockResolvedValue([]);
  vi.mocked(api.getAdminStorage).mockResolvedValue({ totalBytes: 0, chatBytes: 0, usageBytes: 0, otherBytes: 0, diskFreeBytes: null, users: [] });
  vi.mocked(api.getAdminTelegram).mockResolvedValue({
    configured: false, botUsername: null, tokenHint: null, updatedAt: null, polling: 'off', lastError: null, linkedUsers: 0,
  });
  vi.mocked(api.logout).mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); });

async function dashboard(msg: Snapshot = snapshot()) {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('heading', { name: '세션 현황' }, { timeout: 5000 });
  emit(msg);
  return user;
}

describe('바로 열기(/?session=)', () => {
  it('주소의 세션 상세를 열고 주소에서 session을 뺀다', async () => {
    window.history.replaceState(null, '', '/?session=run1');
    await dashboard();
    await waitFor(() => expect(within(panel()).getByText('c-monitor')).toBeInTheDocument(), { timeout: 5000 });
    expect(api.getLog).toHaveBeenCalledWith('run1');
    await waitFor(() => expect(window.location.search).toBe(''), { timeout: 5000 });
  });

  it('지금 목록에 없으면 기록에서 찾아 기록 탭으로 연다', async () => {
    window.history.replaceState(null, '', '/?session=old1');
    vi.mocked(api.getHistory).mockResolvedValue({
      sessions: [mkSession({ id: 'old1', name: 'legacy-app', status: 'end', endedAt: ago(60 * 48) })], machines: [], accounts: [],
    });
    await dashboard();
    // 상세 패널은 세션마다 새로 그려지므로 매번 다시 찾는다.
    await waitFor(() => expect(within(panel()).getByText('legacy-app')).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.getByRole('tab', { name: '기록' })).toHaveAttribute('aria-selected', 'true');
  });

  it('로그인으로 보내질 때 돌아갈 주소(next)에 session이 남는다', () => {
    window.history.replaceState(null, '', '/?session=run1');
    expect(api.nextQuery()).toBe(`?next=${encodeURIComponent('/?session=run1')}`);
  });
});

describe('기록 탭', () => {
  it('종료된 세션만 보이고 검색어·컴퓨터로 거르며, 누르면 읽기 전용 상세(답장 없음)', async () => {
    vi.mocked(api.getHistory).mockResolvedValue({
      sessions: [
        mkSession({ id: 'h1', name: 'alpha-api', status: 'end', machineId: 'm1', branch: 'main', endedAt: ago(100) }),
        mkSession({ id: 'h2', name: 'beta-web', status: 'end', machineId: 'm2', branch: 'feat/x', endedAt: ago(50) }),
        mkSession({ id: 'h3', name: 'gamma-live', status: 'run', machineId: 'm1' }),
      ],
      machines: [mkMachine({ id: 'm1', name: '집 PC' }), mkMachine({ id: 'm2', name: 'server-b' })],
      accounts: [],
    });
    const user = await dashboard();
    await user.click(screen.getByRole('tab', { name: '기록' }));
    const list = await screen.findByRole('region', { name: '기록' });
    expect(await within(list).findByRole('button', { name: /^alpha-api · / })).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: /^beta-web · / })).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: /^gamma-live · / })).not.toBeInTheDocument();

    await user.type(within(list).getByRole('searchbox', { name: '기록 검색' }), 'feat');
    expect(within(list).queryByRole('button', { name: /^alpha-api · / })).not.toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: '검색 지우기' }));
    await user.selectOptions(within(list).getByRole('combobox', { name: '컴퓨터 필터' }), 'm1');
    expect(within(list).queryByRole('button', { name: /^beta-web · / })).not.toBeInTheDocument();

    await user.click(within(list).getByRole('button', { name: /^alpha-api · / }));
    expect(api.getLog).toHaveBeenCalledWith('h1');
    expect(within(panel()).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(panel()).queryByRole('switch')).not.toBeInTheDocument();

    // 지우기
    await user.click(within(list).getByRole('button', { name: '세션 지우기' }));
    expect(api.deleteSession).toHaveBeenCalledWith('h1');
    expect(within(list).queryByRole('button', { name: /^alpha-api · / })).not.toBeInTheDocument();
  });

  it('불러오지 못하면 다시 시도할 수 있다', async () => {
    vi.mocked(api.getHistory).mockRejectedValueOnce(new api.ApiError(500, {}));
    const user = await dashboard();
    await user.click(screen.getByRole('tab', { name: '기록' }));
    expect(await screen.findByText('기록을 불러오지 못했습니다.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(api.getHistory).toHaveBeenCalledTimes(2);
  });
});

describe('공유받은 세션', () => {
  it('따로 묶고 보기만: 지우기·답 버튼·공유·알림 스위치·입력창이 없다', async () => {
    const user = await dashboard();
    const group = screen.getByRole('region', { name: '공유받은 세션' });
    expect(within(group).getAllByText('friend@example.com 공유').length).toBeGreaterThan(0);
    expect(within(group).queryByRole('button', { name: '세션 지우기' })).not.toBeInTheDocument();
    expect(within(group).queryByRole('button', { name: '허용' })).not.toBeInTheDocument();
    // 내 컴퓨터 묶음에는 섞이지 않는다.
    expect(screen.queryByRole('region', { name: '알 수 없는 컴퓨터' })).not.toBeInTheDocument();

    await user.click(within(group).getByRole('button', { name: /^friend-live · / }));
    const p = panel();
    expect(within(p).getByText('공유한 사람')).toBeInTheDocument();
    expect(within(p).queryByRole('button', { name: '공유' })).not.toBeInTheDocument();
    expect(within(p).queryByRole('button', { name: '세션 지우기' })).not.toBeInTheDocument();
    expect(within(p).queryByRole('switch')).not.toBeInTheDocument();
    expect(within(p).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(p).getByText('friend@example.com님이 공유한 세션입니다. 보기만 할 수 있습니다.')).toBeInTheDocument();
    expect(within(p).getByText('세션 주인이 답하면 이어서 진행됩니다.')).toBeInTheDocument();
    expect(api.markSeen).not.toHaveBeenCalled();
  });
});

describe('관리자가 남의 대시보드 보기(?user=)', () => {
  it('띠와 돌아가기를 보이고, 스트림에 ?user=, 쓰기 버튼은 모두 숨긴다', async () => {
    window.history.replaceState(null, '', '/?user=u2');
    vi.mocked(api.getAdminUsers).mockResolvedValue([adminRow({ id: 'u2', email: 'member@example.com', name: '홍길동', role: 'user' })]);
    const user = await dashboard();
    expect(streamOpts?.url).toBe('/api/stream?user=u2');
    expect(await screen.findByText('홍길동(member@example.com)')).toBeInTheDocument();
    expect(screen.getByText(/님의 대시보드를 보고 있습니다 · 읽기 전용/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '돌아가기' })).toHaveAttribute('href', '/admin#users');
    expect(screen.queryByRole('button', { name: '세션 지우기' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '허용' })).not.toBeInTheDocument();
    expect(api.getNotify).not.toHaveBeenCalled();

    await user.click(card(/^search-api · /));
    const p = panel();
    expect(api.markSeen).not.toHaveBeenCalled();
    expect(within(p).queryByRole('button', { name: '공유' })).not.toBeInTheDocument();
    expect(within(p).queryByRole('button', { name: '허용' })).not.toBeInTheDocument();
    expect(within(p).queryByRole('switch')).not.toBeInTheDocument();
    expect(within(p).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(p).getByText('읽기 전용으로 보고 있습니다. 답장·삭제·설정은 바꿀 수 없습니다.')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: '기록' }));
    expect(api.getHistory).toHaveBeenCalledWith('u2');
  });

  it('관리자가 아니면 ?user=를 무시하고 내 대시보드를 본다', async () => {
    vi.mocked(api.getMe).mockResolvedValue(meOf({ role: 'user' }));
    window.history.replaceState(null, '', '/?user=u2');
    await dashboard();
    expect(streamOpts?.url).toBeUndefined();
    expect(screen.queryByText(/님의 대시보드를 보고 있습니다/)).not.toBeInTheDocument();
  });
});

describe('컨텍스트·비용·답 기록', () => {
  it('상세에 컨텍스트 %(막대)와 비용, 카드에 작은 컨텍스트 %. 모르면 숨긴다', async () => {
    const user = await dashboard();
    expect(within(card(/^c-monitor · /)).getByText('컨텍스트 64%')).toBeInTheDocument();
    expect(within(card(/^search-api · /)).queryByText(/컨텍스트/)).not.toBeInTheDocument();
    await user.click(card(/^c-monitor · /));
    const p = panel();
    expect(within(p).getByText('64% 사용')).toBeInTheDocument();
    expect(within(p).getByRole('meter', { name: '컨텍스트 사용률' })).toHaveAttribute('aria-valuenow', '64');
    expect(within(p).getByText('$3.12')).toBeInTheDocument();
    await user.click(card(/^search-api · /));
    expect(within(panel()).queryByText('비용(추정)')).not.toBeInTheDocument();
  });

  it('웹·텔레그램 답 기록을 대화 줄 사이에 시스템 줄로 끼운다(스트림 reply 포함)', async () => {
    vi.mocked(api.getLog).mockResolvedValue({
      lines: [mkLine(0, { at: ago(10), text: '첫 줄' }), mkLine(1, { at: ago(2), text: '둘째 줄' })],
      total: 2, hasMoreBefore: false, hasMoreAfter: false,
    });
    vi.mocked(api.getReplies).mockResolvedValue([{ id: 'r1', at: ago(5), source: 'web', kind: 'permission', label: '허용' }]);
    const user = await dashboard();
    await user.click(card(/^c-monitor · /));
    const p = panel();
    const note = await within(p).findByText(/웹에서 「허용」으로 답했습니다 · 5분 전/);
    const log = within(p).getByRole('log');
    const texts = [...log.querySelectorAll('.ln')].map((el) => el.textContent ?? '');
    expect(texts.findIndex((t) => t.includes('첫 줄'))).toBeLessThan(texts.findIndex((t) => t.includes('허용')));
    expect(texts.findIndex((t) => t.includes('허용'))).toBeLessThan(texts.findIndex((t) => t.includes('둘째 줄')));
    expect(note).toBeInTheDocument();

    emit({ type: 'reply', sessionId: 'run1', reply: { id: 'r2', at: ago(0), source: 'telegram', kind: 'permission', label: '거부' } });
    expect(await within(p).findByText(/텔레그램에서 「거부」로 답했습니다/)).toBeInTheDocument();
  });
});

describe('웹 알림 소리', () => {
  it('내 세션이 wait·done이 되면 울리고, 끄면 울리지 않는다', async () => {
    await dashboard();
    emit({ type: 'session', session: mkSession({ id: 'run1', name: 'c-monitor', status: 'done' }) });
    expect(playChime).toHaveBeenLastCalledWith('done');
    emit({ type: 'session', session: mkSession({ id: 'end1', name: 'homepage', status: 'wait' }) });
    expect(playChime).toHaveBeenLastCalledWith('wait');
    vi.mocked(playChime).mockClear();
    localStorage.setItem('cs-sound', '0');
    emit({ type: 'session', session: mkSession({ id: 'run1', name: 'c-monitor', status: 'wait' }) });
    expect(playChime).not.toHaveBeenCalled();
  });

  it('공유받은 세션이나 처음 받은 목록으로는 울리지 않는다', async () => {
    await dashboard();
    emit({ type: 'session', session: mkSession({ id: 'sh1', name: 'friend-repo', status: 'done', sharedBy: 'friend@example.com' }) });
    expect(playChime).not.toHaveBeenCalled();
  });

  it('설정 › 알림에서 이 브라우저의 소리를 끄고 켠다(localStorage)', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getNotify).mockResolvedValue(notifyOf());
    render(<NotifySection />);
    const sw = await screen.findByRole('switch', { name: '웹 알림 소리' });
    expect(sw).toBeChecked();
    await user.click(sw);
    expect(localStorage.getItem('cs-sound')).toBe('0');
    await user.click(sw);
    expect(localStorage.getItem('cs-sound')).toBe('1');
  });
});

describe('공유 창', () => {
  it('링크를 만들면 한 번만 보이는 주소와 복사, 목록에 붙고 취소할 수 있다', async () => {
    vi.mocked(api.createShare).mockResolvedValue({
      id: 'sh-1', kind: 'link', url: 'https://cmon.example/s/abc', email: null, expiresAt: later(60 * 24 * 7), createdAt: ago(0),
    });
    vi.mocked(api.deleteShare).mockResolvedValue({ ok: true });
    const user = await dashboard();
    await user.click(card(/^c-monitor · /));
    await user.click(within(panel()).getByRole('button', { name: '공유' }));
    const dlg = screen.getByRole('dialog', { name: 'c-monitor 공유' });
    await user.selectOptions(within(dlg).getByRole('combobox', { name: '만료' }), '7d');
    await user.click(within(dlg).getByRole('button', { name: '링크 만들기' }));
    expect(api.createShare).toHaveBeenCalledWith('run1', { kind: 'link', expiresIn: '7d' });
    expect(await within(dlg).findByRole('textbox', { name: '만든 공유 링크' })).toHaveValue('https://cmon.example/s/abc');
    expect(within(dlg).getByText(/이 주소는 지금 한 번만 보입니다/)).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '복사' }));
    await expect(navigator.clipboard.readText()).resolves.toBe('https://cmon.example/s/abc');
    expect(await within(dlg).findByRole('button', { name: '복사됨' })).toBeInTheDocument();

    const list = within(dlg).getByRole('region', { name: '공유 목록' });
    await user.click(within(list).getByRole('button', { name: '취소' }));
    expect(api.deleteShare).toHaveBeenCalledWith('sh-1');
    await waitFor(() => expect(within(dlg).queryByRole('textbox', { name: '만든 공유 링크' })).not.toBeInTheDocument());
    expect(within(dlg).getByText('아직 공유하지 않았습니다.')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('사람 지정: 가입하지 않은 이메일·자기 자신이면 까닭을 보이고, 되면 목록에 붙는다', async () => {
    const user = await dashboard();
    await user.click(card(/^c-monitor · /));
    await user.click(within(panel()).getByRole('button', { name: '공유' }));
    const dlg = screen.getByRole('dialog');
    const input = within(dlg).getByRole('textbox', { name: '공유할 사람 이메일' });

    vi.mocked(api.createShare).mockRejectedValueOnce(new api.ApiError(409, { error: 'user_not_found' }));
    await user.type(input, 'nobody@example.com{Enter}');
    expect(await within(dlg).findByText(/가입하지 않은 이메일입니다/)).toBeInTheDocument();

    vi.mocked(api.createShare).mockRejectedValueOnce(new api.ApiError(409, { error: 'self' }));
    await user.click(within(dlg).getByRole('button', { name: '추가' }));
    expect(await within(dlg).findByText('자기 자신에게는 공유할 수 없습니다.')).toBeInTheDocument();

    vi.mocked(api.createShare).mockResolvedValueOnce({ id: 'sh-2', kind: 'user', url: null, email: 'friend@example.com', expiresAt: null, createdAt: ago(0) });
    await user.clear(input);
    await user.type(input, 'Friend@Example.com');
    await user.click(within(dlg).getByRole('button', { name: '추가' }));
    expect(api.createShare).toHaveBeenLastCalledWith('run1', { kind: 'user', email: 'friend@example.com' });
    expect(await within(within(dlg).getByRole('region', { name: '공유 목록' })).findByText('friend@example.com')).toBeInTheDocument();
  });
});

describe('공개 링크 보기(/s/<토큰>)', () => {
  const pub = {
    name: 'search-api', status: 'run' as const, branch: 'main', model: 'Opus 5.5', startedAt: ago(30), lastEventAt: ago(0),
    endedAt: null, activity: null, contextPct: 40, costUsd: 1.5, expiresAt: later(60),
  };

  it('로그인 없이 보기만: 대화·실시간 줄, 쓰기·검색·컴퓨터 정보 없음', async () => {
    window.history.replaceState(null, '', '/s/tok-123');
    vi.mocked(api.getPublicSession).mockResolvedValue(pub);
    vi.mocked(api.getPublicLog).mockResolvedValue({ lines: [mkLine(0, { text: '공개 첫 줄' })], total: 1, hasMoreBefore: false, hasMoreAfter: false });
    render(<App />);
    const p = await screen.findByRole('complementary', { name: '세션 상세' });
    expect(api.getMe).not.toHaveBeenCalled();
    expect(api.getPublicSession).toHaveBeenCalledWith('tok-123');
    expect(within(p).getByText('search-api')).toBeInTheDocument();
    expect(await within(p).findByText('공개 첫 줄')).toBeInTheDocument();
    expect(within(p).getByText('링크 만료')).toBeInTheDocument();
    expect(within(p).queryByText('컴퓨터')).not.toBeInTheDocument();
    expect(within(p).queryByText('클로드 계정')).not.toBeInTheDocument();
    expect(within(p).queryByRole('searchbox')).not.toBeInTheDocument();
    expect(within(p).queryByRole('button', { name: '공유' })).not.toBeInTheDocument();
    expect(within(p).queryByRole('button', { name: '세션 지우기' })).not.toBeInTheDocument();
    expect(within(p).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(p).queryByRole('switch')).not.toBeInTheDocument();
    expect(within(p).getByText('보기 전용 링크입니다. 답하거나 바꿀 수 없습니다.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '설정' })).not.toBeInTheDocument();

    await waitFor(() => expect(streamOpts?.url).toBe('/api/public/s/tok-123/stream'));
    emit({ type: 'log', lines: [mkLine(1, { text: '실시간 둘째 줄' })] });
    expect(await within(p).findByText('실시간 둘째 줄')).toBeInTheDocument();
    emit({ type: 'public', session: { ...pub, status: 'done' } });
    expect(await within(p).findByText('작업이 끝났습니다')).toBeInTheDocument();
  });

  it('없거나 만료·취소된 링크(404)면 안내만 보인다', async () => {
    window.history.replaceState(null, '', '/s/gone');
    vi.mocked(api.getPublicSession).mockRejectedValue(new api.ApiError(404, { error: 'not_found' }));
    vi.mocked(api.getPublicLog).mockRejectedValue(new api.ApiError(404, { error: 'not_found' }));
    render(<App />);
    expect(await screen.findByText('볼 수 없는 링크입니다')).toBeInTheDocument();
    expect(screen.getByText(/링크가 만료되었거나 공유가 취소되었습니다/)).toBeInTheDocument();
  });
});

describe('가입 고지 동의', () => {
  it('동의 전이면 동의 화면만 보이고, 체크해야 "동의하고 계속"을 누를 수 있다', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getMe).mockResolvedValue(meOf({ consentedAt: null }));
    vi.mocked(api.consent).mockResolvedValue(meOf());
    render(<App />);
    expect(await screen.findByText('관리자는 서비스 운영을 위해 모든 대화를 볼 수 있습니다.')).toBeInTheDocument();
    expect(screen.getByText(/가려서\(키 N개 가려짐\) 저장합니다/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '세션 현황' })).not.toBeInTheDocument();
    const go = screen.getByRole('button', { name: '동의하고 계속' });
    expect(go).toBeDisabled();
    await u.click(screen.getByRole('checkbox', { name: '위 내용을 확인했고 동의합니다.' }));
    await u.click(go);
    expect(api.consent).toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: '세션 현황' })).toBeInTheDocument();
  });

  it('승인 대기 사용자는 동의한 뒤 /pending으로 간다', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getMe).mockResolvedValue(meOf({ consentedAt: null, status: 'pending', role: 'user' }));
    vi.mocked(api.consent).mockResolvedValue(meOf({ status: 'pending', role: 'user' }));
    render(<App />);
    await u.click(await screen.findByRole('checkbox'));
    await u.click(screen.getByRole('button', { name: '동의하고 계속' }));
    await waitFor(() => expect(window.location.pathname).toBe('/pending'));
  });
});

describe('탈퇴', () => {
  it('설정 › 계정: "탈퇴"를 입력해야 신청되고, 그 뒤 탈퇴 취소 화면으로 간다', async () => {
    const u = userEvent.setup();
    vi.mocked(api.withdraw).mockResolvedValue(meOf({ deleteAt: later(60 * 24 * 7) }));
    render(<AccountSection me={meOf()} />);
    await u.click(screen.getByRole('button', { name: '탈퇴' }));
    const go = screen.getByRole('button', { name: '탈퇴 신청' });
    expect(go).toBeDisabled();
    await u.type(screen.getByLabelText(/확인하려면/), '탈퇴');
    await u.click(go);
    expect(api.withdraw).toHaveBeenCalled();
    await waitFor(() => expect(window.location.pathname).toBe('/withdrawn'));
  });

  it('탈퇴 중이면 "탈퇴 취소" 화면만 보이고, 취소하면 대시보드로', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getMe).mockResolvedValue(meOf({ deleteAt: '2026-11-21T09:00:00Z' }));
    vi.mocked(api.restoreMe).mockResolvedValue(meOf());
    window.history.replaceState(null, '', '/settings');
    render(<App />);
    expect(await screen.findByText('탈퇴를 신청한 계정입니다')).toBeInTheDocument();
    expect(screen.getByText(/2026년 11월 21일/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '설정' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '로그아웃' })).toBeInTheDocument();
    vi.mocked(api.getMe).mockResolvedValue(meOf());
    await u.click(screen.getByRole('button', { name: '탈퇴 취소' }));
    expect(api.restoreMe).toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: '세션 현황' })).toBeInTheDocument();
  });

  it('API가 403 withdrawn을 주면 /withdrawn으로 옮긴다', async () => {
    const real = await vi.importActual<typeof import('../api/client')>('../api/client');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'withdrawn' }), { status: 403 })));
    await expect(real.getDashboard()).rejects.toBeInstanceOf(real.ApiError);
    expect(window.location.pathname).toBe('/withdrawn');
  });
});

describe('설정 › 계정·보관 기간', () => {
  it('내 사용량/한도 막대와 오래된 대화를 지운 안내', async () => {
    vi.mocked(api.getMyStorage).mockResolvedValue({ bytes: 900 * 1024 * 1024, quotaMb: 1024, trimmedAt: ago(60) });
    render(<AccountSection me={meOf()} />);
    expect(await screen.findByText('900MB / 1GB 사용')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: '내 저장 용량' })).toHaveAttribute('aria-valuenow', '88');
    expect(screen.getByText(/오래된 대화를 지웠습니다/)).toBeInTheDocument();
  });

  it('한도 0이면 막대 없이 "한도 없음"', async () => {
    vi.mocked(api.getMyStorage).mockResolvedValue({ bytes: 5 * 1024 * 1024, quotaMb: 0, trimmedAt: null });
    render(<AccountSection me={meOf()} />);
    expect(await screen.findByText('5MB 사용 · 한도 없음')).toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('보관 기간은 0(지우지 않음)부터 받는다', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getDashboard).mockResolvedValue({ sessions: [], machines: [], accounts: [] } as DashboardSnapshot);
    vi.mocked(api.putSettings).mockResolvedValue(undefined);
    render(<Settings me={meOf()} />);
    const chat = await screen.findByLabelText('대화 기록');
    expect(chat).toHaveAttribute('min', '0');
    expect(screen.getAllByText(/0을 넣으면 지우지 않습니다/).length).toBeGreaterThan(0);
    await waitFor(() => expect(chat).toHaveValue(30));
    await u.clear(chat);
    await u.type(chat, '0');
    await u.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(api.putSettings).toHaveBeenCalledWith({ lostMinutes: 10, endHours: 24, keepChatDays: 0, keepUsageDays: 90 }));
    expect(screen.getByRole('navigation', { name: '설정 메뉴' })).toHaveTextContent('계정');
  });
});

describe('웹 알림(이 브라우저에서 받기)', () => {
  it('지원하지 않는 브라우저면 안내만, 이 계정의 다른 브라우저는 목록에서 해제할 수 있다', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getNotify).mockResolvedValue(notifyOf({ linked: false }));
    vi.mocked(api.getPushSubscriptions).mockResolvedValue([{ endpoint: 'https://push.example/a', label: 'Chrome · Android', createdAt: ago(60) }]);
    vi.mocked(api.pushUnsubscribe).mockResolvedValue({ ok: true });
    render(<NotifySection />);
    const web = await screen.findByRole('group', { name: '웹 알림' });
    expect(within(web).getByText(/이 브라우저는 웹 알림을 지원하지 않습니다/)).toBeInTheDocument();
    expect(within(web).queryByRole('button', { name: '이 브라우저에서 받기' })).not.toBeInTheDocument();
    expect(await within(web).findByText('Chrome · Android')).toBeInTheDocument();
    // 웹 알림이 하나라도 있으면 텔레그램 없이도 항목을 고를 수 있다.
    expect(screen.getByRole('switch', { name: '답을 기다릴 때' })).toBeEnabled();
    expect(screen.getByText('텔레그램·웹 알림 공통')).toBeInTheDocument();
    await u.click(within(web).getByRole('button', { name: 'Chrome · Android 웹 알림 해제' }));
    expect(api.pushUnsubscribe).toHaveBeenCalledWith('https://push.example/a');
    await waitFor(() => expect(screen.getByRole('switch', { name: '답을 기다릴 때' })).toBeDisabled());
  });

  it('아이폰에서 홈 화면에 추가하지 않았으면 그렇게 하라고 알린다', async () => {
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' });
    vi.mocked(api.getNotify).mockResolvedValue(notifyOf());
    render(<NotifySection />);
    expect(await screen.findByText(/홈 화면에 추가/)).toBeInTheDocument();
  });

  it('지원하면 권한을 묻고 구독해 서버에 브라우저 이름과 함께 알리고, 시험 알림·해제', async () => {
    const u = userEvent.setup();
    const sub = {
      endpoint: 'https://push.example/me',
      toJSON: () => ({ endpoint: 'https://push.example/me', keys: { p256dh: 'p-key', auth: 'a-key' } }),
      unsubscribe: vi.fn(async () => true),
    };
    let current: typeof sub | null = null;
    const pushManager = { getSubscription: vi.fn(async () => current), subscribe: vi.fn(async () => { current = sub; return sub; }) };
    const reg = { pushManager };
    const serviceWorker = {
      register: vi.fn(async () => reg), ready: Promise.resolve(reg), getRegistration: vi.fn(async () => reg), addEventListener: vi.fn(),
    };
    vi.stubGlobal('navigator', {
      ...navigator, serviceWorker,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
    });
    vi.stubGlobal('PushManager', function PushManager() {});
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn(async () => 'granted') });
    vi.mocked(api.getPushKey).mockResolvedValue({ publicKey: 'AQID' });
    vi.mocked(api.pushSubscribe).mockResolvedValue({ ok: true });
    vi.mocked(api.pushTest).mockResolvedValue({ ok: true });
    vi.mocked(api.pushUnsubscribe).mockResolvedValue({ ok: true });
    vi.mocked(api.getNotify).mockResolvedValue(notifyOf({ linked: false }));
    vi.mocked(api.getPushSubscriptions).mockResolvedValue([]);
    render(<NotifySection />);
    const web = await screen.findByRole('group', { name: '웹 알림' });
    vi.mocked(api.getPushSubscriptions).mockResolvedValue([{ endpoint: 'https://push.example/me', label: 'Chrome · Windows', createdAt: ago(0) }]);
    await u.click(within(web).getByRole('button', { name: '이 브라우저에서 받기' }));
    await waitFor(() => expect(api.pushSubscribe).toHaveBeenCalledWith({
      endpoint: 'https://push.example/me', keys: { p256dh: 'p-key', auth: 'a-key' }, label: 'Chrome · Windows',
    }));
    expect(serviceWorker.register).toHaveBeenCalledWith('/sw.js');
    expect(await within(web).findByText('이 브라우저에서 받는 중')).toBeInTheDocument();
    expect(within(web).getByText('이 브라우저')).toBeInTheDocument();

    await u.click(within(web).getByRole('button', { name: '시험 알림' }));
    expect(api.pushTest).toHaveBeenCalledWith('https://push.example/me');
    expect(await within(web).findByText(/시험 알림을 보냈습니다/)).toBeInTheDocument();

    await u.click(within(web).getByRole('button', { name: '해제' }));
    expect(api.pushUnsubscribe).toHaveBeenCalledWith('https://push.example/me');
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(await within(web).findByRole('button', { name: '이 브라우저에서 받기' })).toBeInTheDocument();
  });
});

describe('관리 화면', () => {
  const machinesRows: AdminMachineView[] = [
    { ...mkMachine({ id: 'm1', name: '집 PC', os: 'Windows 11', pluginVersion: '0.3.0' }), ownerId: 'u1', ownerEmail: 'admin@example.com', account: 'dev@company-a.example' },
    { ...mkMachine({ id: 'm2', name: 'server-b', remoteReply: false }), ownerId: 'u3', ownerEmail: 'member@example.com', account: null },
  ];

  it('메뉴 순서와 사용자 표: 사용량·한도 바로 편집·권한(자기 자신은 못 바꿈)·대시보드 보기', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getAdminUsers).mockResolvedValue([
      adminRow(),
      adminRow({ id: 'u3', email: 'member@example.com', name: '홍길동', role: 'user', machines: 1 }),
    ]);
    vi.mocked(api.patchAdminUser).mockImplementation(async (id, p) => adminRow({ id, email: 'member@example.com', role: 'user', ...p }));
    render(<AdminUsers me={meOf()} />);
    expect(screen.getByRole('navigation', { name: '관리 메뉴' }).textContent).toBe('승인 대기사용자컴퓨터알림저장 용량');
    const users = screen.getByRole('region', { name: '사용자' });
    const self = (await within(users).findByText('admin@example.com')).closest('tr')!;
    expect(within(self).getByRole('combobox', { name: 'admin@example.com 권한' })).toBeDisabled();
    expect(within(self).queryByRole('link', { name: /대시보드 보기/ })).not.toBeInTheDocument();

    const row = within(users).getByText('member@example.com').closest('tr')!;
    expect(within(row).getByText('300MB')).toBeInTheDocument();
    expect(within(row).getByText('1대')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'member@example.com 대시보드 보기' })).toHaveAttribute('href', '/?user=u3');
    const quota = within(row).getByRole('spinbutton', { name: /용량 한도/ });
    await u.clear(quota);
    await u.type(quota, '0{Enter}');
    expect(api.patchAdminUser).toHaveBeenCalledWith('u3', { quotaMb: 0 });
    expect(await screen.findByText(/용량 한도를 무제한으로 바꿨습니다/)).toBeInTheDocument();
    await u.selectOptions(within(row).getByRole('combobox', { name: 'member@example.com 권한' }), 'admin');
    expect(api.patchAdminUser).toHaveBeenLastCalledWith('u3', { role: 'admin' });
  });

  it('사용자 추가(이메일+권한), 초대됨 표시', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getAdminUsers).mockResolvedValue([adminRow()]);
    vi.mocked(api.createAdminUser).mockResolvedValue(adminRow({ id: 'u9', email: 'new@example.com', role: 'admin', invited: true, lastLoginAt: null, bytes: 0, machines: 0 }));
    render(<AdminUsers me={meOf()} />);
    await screen.findByText('admin@example.com');
    await u.type(screen.getByLabelText('Gmail 주소'), 'New@Example.com');
    await u.selectOptions(screen.getByRole('combobox', { name: '추가할 사용자 권한' }), 'admin');
    await u.click(screen.getByRole('button', { name: '사용자 추가' }));
    expect(api.createAdminUser).toHaveBeenCalledWith('new@example.com', 'admin');
    const row = (await screen.findByText('new@example.com')).closest('tr')!;
    expect(within(row).getByText('초대됨')).toBeInTheDocument();
    expect(within(row).getByText('로그인 전')).toBeInTheDocument();
  });

  it('탈퇴 예정 사용자: 표시와 복구, 즉시 삭제는 한 번 더 눌러 확인', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getAdminUsers).mockResolvedValue([
      adminRow(),
      adminRow({ id: 'u4', email: 'leaving@example.com', role: 'user', deleteAt: '2026-11-21T09:00:00Z' }),
      adminRow({ id: 'u5', email: 'bye@example.com', role: 'user', deleteAt: '2026-11-20T09:00:00Z' }),
    ]);
    vi.mocked(api.restoreAdminUser).mockResolvedValue(adminRow({ id: 'u4', email: 'leaving@example.com', role: 'user', deleteAt: null }));
    vi.mocked(api.deleteAdminUser).mockResolvedValue({ ok: true });
    render(<AdminUsers me={meOf()} />);
    const row = (await screen.findByText('leaving@example.com')).closest('tr')!;
    expect(within(row).getByText('탈퇴 예정')).toBeInTheDocument();
    await u.click(within(row).getByRole('button', { name: '복구' }));
    expect(api.restoreAdminUser).toHaveBeenCalledWith('u4');
    await waitFor(() => expect(within(row).queryByText('탈퇴 예정')).not.toBeInTheDocument());

    const bye = screen.getByText('bye@example.com').closest('tr')!;
    await u.click(within(bye).getByRole('button', { name: '즉시 삭제' }));
    expect(api.deleteAdminUser).not.toHaveBeenCalled();
    await u.click(within(bye).getByRole('button', { name: '삭제 확인' }));
    expect(api.deleteAdminUser).toHaveBeenCalledWith('u5');
    await waitFor(() => expect(screen.queryByText('bye@example.com')).not.toBeInTheDocument());
  });

  it('컴퓨터: 모든 사용자의 컴퓨터, 원격 답장 스위치, 연결 해제(확인)', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getAdminUsers).mockResolvedValue([adminRow()]);
    vi.mocked(api.getAdminMachines).mockResolvedValue(machinesRows);
    vi.mocked(api.patchAdminMachine).mockImplementation(async (id, p) => ({ ...machinesRows.find((m) => m.id === id)!, ...p }));
    vi.mocked(api.deleteAdminMachine).mockResolvedValue({ ok: true });
    render(<AdminUsers me={meOf()} />);
    const sec = screen.getByRole('region', { name: '컴퓨터' });
    const row = (await within(sec).findByText('server-b')).closest('tr')!;
    expect(within(row).getByText('member@example.com')).toBeInTheDocument();
    const sw = within(row).getByRole('switch', { name: 'server-b(member@example.com) 원격 답장' });
    expect(sw).not.toBeChecked();
    await u.click(sw);
    expect(api.patchAdminMachine).toHaveBeenCalledWith('m2', { remoteReply: true });
    await u.click(within(row).getByRole('button', { name: '연결 해제' }));
    expect(api.deleteAdminMachine).not.toHaveBeenCalled();
    await u.click(within(row).getByRole('button', { name: '해제 확인' }));
    expect(api.deleteAdminMachine).toHaveBeenCalledWith('m2');
    await waitFor(() => expect(within(sec).queryByText('server-b')).not.toBeInTheDocument());
    expect(within(sec.querySelector('tbody')!).getByText('company-a.example')).toBeInTheDocument();
  });

  it('저장 용량: 전체·대화·사용량·기타·디스크 남은 공간·사용자별', async () => {
    vi.mocked(api.getAdminUsers).mockResolvedValue([adminRow()]);
    const MB = 1024 * 1024;
    vi.mocked(api.getAdminStorage).mockResolvedValue({
      totalBytes: 418 * MB, chatBytes: 412 * MB, usageBytes: 3 * MB, otherBytes: 3 * MB, diskFreeBytes: 29 * 1024 * MB,
      users: [{ id: 'u1', email: 'admin@example.com', bytes: 400 * MB, quotaMb: 0 }, { id: 'u3', email: 'member@example.com', bytes: 900 * MB, quotaMb: 1024 }],
    });
    render(<AdminUsers me={meOf()} />);
    const sec = screen.getByRole('region', { name: '저장 용량' });
    expect(await within(sec).findByText('전체 418MB')).toBeInTheDocument();
    expect(within(sec).getByText('디스크 남은 공간 29GB')).toBeInTheDocument();
    expect(within(sec).getByRole('img', { name: '대화 412MB, 사용량 3MB, 기타 3MB' })).toBeInTheDocument();
    const table = within(sec).getByRole('table', { name: '사용자별 저장 용량' });
    const rows = within(table).getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(rows[0]).toContain('member@example.com');
    expect(rows[0]).toContain('88%');
    expect(rows[1]).toContain('한도 없음');
  });
});
