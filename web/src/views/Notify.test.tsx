import { NOTIFY_DEFAULTS, type AdminTelegramView, type MeResponse, type NotifyView } from '@c-monitor/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { AdminUsers } from './AdminUsers';
import { NotifySection, POLL_MS } from './Notify';
import { Settings } from './Settings';

vi.mock('../api/stream', () => ({ connectStream: vi.fn(() => () => {}) }));
vi.mock('../api/client', async (orig) => ({
  ...(await orig<typeof import('../api/client')>()),
  getNotify: vi.fn(),
  putNotifySettings: vi.fn(),
  createTelegramLink: vi.fn(),
  unlinkTelegram: vi.fn(),
  sendTelegramTest: vi.fn(async () => ({ ok: true })),
  getAdminTelegram: vi.fn(),
  putAdminTelegram: vi.fn(),
  deleteAdminTelegram: vi.fn(),
  getAdminUsers: vi.fn(async () => []),
  getDashboard: vi.fn(async () => ({ sessions: [], machines: [], accounts: [] })),
  getSettings: vi.fn(async () => ({ lostMinutes: 10, endHours: 24, keepChatDays: 30, keepUsageDays: 90 })),
}));

const BOT = 'c_monitor_test_bot';
const nv = (tg: Partial<NotifyView['telegram']> = {}, s: Partial<NotifyView['settings']> = {}): NotifyView => ({
  telegram: { available: true, botUsername: BOT, linked: false, linkedName: null, linkedAt: null, ...tg },
  settings: { ...NOTIFY_DEFAULTS, ...s },
});
const linkedView = (s: Partial<NotifyView['settings']> = {}) =>
  nv({ linked: true, linkedName: '@hong', linkedAt: new Date().toISOString() }, s);
const meOf = (role: 'admin' | 'user' = 'user'): MeResponse => ({
  user: { id: 'u1', email: 'someone@example.com', name: null, role, status: 'active' },
});
const region = () => screen.findByRole('region', { name: '알림' });

/** 새 탭 열기(window.open)를 흉내 낸다. 열린 탭의 주소를 확인할 수 있게 돌려준다. */
function stubOpen() {
  const tab = { location: { href: '' }, opener: {} as unknown, close: vi.fn() };
  const open = vi.fn(() => tab as unknown as Window);
  vi.stubGlobal('open', open);
  return { open, tab };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/settings');
  vi.mocked(api.putNotifySettings).mockImplementation(async (s) => nv({ linked: true, linkedName: '@hong' }, s));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('설정 › 알림 · 봇 없음', () => {
  it('일반 사용자에게는 관리자에게 요청하라는 문구만 보인다', async () => {
    vi.mocked(api.getNotify).mockResolvedValue(nv({ available: false, botUsername: null }));
    render(<NotifySection />);
    const sec = await region();
    expect(await within(sec).findByText(/서버에 텔레그램 봇이 설정되지 않았습니다\./)).toBeInTheDocument();
    expect(within(sec).getByText(/관리자에게 텔레그램 봇 설정을 요청하세요\./)).toBeInTheDocument();
    expect(within(sec).queryByRole('switch')).not.toBeInTheDocument();
    expect(within(sec).queryByRole('button')).not.toBeInTheDocument();
  });

  it('관리자에게는 관리 › 알림 링크를 보인다', async () => {
    vi.mocked(api.getNotify).mockResolvedValue(nv({ available: false, botUsername: null }));
    render(<NotifySection isAdmin />);
    const sec = await region();
    const link = await within(sec).findByRole('link', { name: '관리 › 알림' });
    expect(link).toHaveAttribute('href', '/admin#notify');
    expect(within(sec).getByText(/에서 봇 토큰을 넣어 주세요\./)).toBeInTheDocument();
  });

  it('설정 화면 메뉴에 "알림"이 있고 절로 이동한다', async () => {
    vi.mocked(api.getNotify).mockResolvedValue(nv());
    render(<Settings me={meOf()} />);
    expect(screen.getByRole('navigation', { name: '설정 메뉴' })).toHaveTextContent('알림');
    expect(screen.getByRole('link', { name: '알림' })).toHaveAttribute('href', '#notify');
    expect(await screen.findByRole('button', { name: '텔레그램 연결' })).toBeInTheDocument();
  });
});

describe('설정 › 알림 · 연결', () => {
  it('링크를 받아 새 탭으로 열고, 3초마다 다시 물어 연결되면 "연결되었습니다"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const u = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { open, tab } = stubOpen();
    vi.mocked(api.getNotify).mockResolvedValueOnce(nv());
    const url = `https://t.me/${BOT}?start=AB12CD34`;
    vi.mocked(api.createTelegramLink).mockResolvedValue({
      code: 'AB12CD34', url, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    render(<NotifySection />);
    await u.click(await screen.findByRole('button', { name: '텔레그램 연결' }));

    // 누른 순간 빈 탭을 열고, 링크를 받으면 그 탭을 링크로 보낸다(팝업 차단 피하기).
    expect(open).toHaveBeenCalledWith('', '_blank');
    await waitFor(() => expect(tab.location.href).toBe(url));
    expect(tab.opener).toBeNull();
    expect(screen.getByText('텔레그램에서 시작을 누르면 연결됩니다.')).toBeInTheDocument();
    expect(screen.getByLabelText('연결 코드')).toHaveTextContent('AB12CD34');
    expect(screen.getByRole('timer')).toHaveTextContent(/^(9분 \d+초|10분 0초) 남음$/);
    const direct = screen.getByRole('link', { name: '텔레그램 열기' });
    expect(direct).toHaveAttribute('href', url);
    expect(direct).toHaveAttribute('target', '_blank');
    expect(screen.getByText(`/start AB12CD34`)).toBeInTheDocument();
    // 연결되지 않으면 스위치는 막혀 있다.
    expect(screen.getByRole('switch', { name: '답을 기다릴 때' })).toBeDisabled();

    // 3초 뒤 첫 확인: 아직 연결 안 됨.
    vi.mocked(api.getNotify).mockResolvedValueOnce(nv());
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    expect(api.getNotify).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('연결되었습니다.')).not.toBeInTheDocument();

    // 다음 확인에서 연결됨.
    vi.mocked(api.getNotify).mockResolvedValueOnce(linkedView());
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    expect(await screen.findByText('연결되었습니다.')).toBeInTheDocument();
    expect(screen.getByText('@hong')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '시험 메시지 보내기' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '답을 기다릴 때' })).toBeEnabled();

    // 연결된 뒤에는 더 묻지 않는다.
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 3); });
    expect(api.getNotify).toHaveBeenCalledTimes(3);
  });

  it('화면을 떠나면 다시 묻기를 멈춘다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const u = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    stubOpen();
    vi.mocked(api.getNotify).mockResolvedValue(nv());
    vi.mocked(api.createTelegramLink).mockResolvedValue({
      code: 'AB12CD34', url: `https://t.me/${BOT}?start=AB12CD34`, expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const view = render(<NotifySection />);
    await u.click(await screen.findByRole('button', { name: '텔레그램 연결' }));
    await screen.findByLabelText('연결 코드');
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    const calls = vi.mocked(api.getNotify).mock.calls.length;
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 5); });
    expect(vi.mocked(api.getNotify).mock.calls.length).toBe(calls);
  });

  it('코드가 만료되면(최대 10분) 묻기를 멈추고 "코드 다시 받기"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const u = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    stubOpen();
    vi.mocked(api.getNotify).mockResolvedValue(nv());
    // 서버가 10분보다 긴 유효 시간을 줘도 10분에서 멈춘다.
    vi.mocked(api.createTelegramLink).mockResolvedValue({
      code: 'ZZ99', url: `https://t.me/${BOT}?start=ZZ99`, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    render(<NotifySection />);
    await u.click(await screen.findByRole('button', { name: '텔레그램 연결' }));
    await screen.findByLabelText('연결 코드');
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000 + POLL_MS); });
    expect(await screen.findByText('연결 코드가 만료되었습니다. 코드를 다시 받아 주세요.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '코드 다시 받기' })).toBeInTheDocument();
    const calls = vi.mocked(api.getNotify).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 3); });
    expect(vi.mocked(api.getNotify).mock.calls.length).toBe(calls);
  });

  it('링크를 받지 못하면 열어 둔 빈 탭을 닫고 알린다', async () => {
    const u = userEvent.setup();
    const { tab } = stubOpen();
    vi.mocked(api.getNotify).mockResolvedValue(nv());
    vi.mocked(api.createTelegramLink).mockRejectedValue(new ApiError(500, {}));
    render(<NotifySection />);
    await u.click(await screen.findByRole('button', { name: '텔레그램 연결' }));
    expect(await screen.findByText('연결 링크를 받지 못했습니다. 잠시 뒤 다시 시도해 주세요.')).toBeInTheDocument();
    expect(tab.close).toHaveBeenCalled();
  });

  it('그사이 봇이 꺼졌으면(409 telegram_unavailable) "봇 없음" 안내로 바꾼다', async () => {
    const u = userEvent.setup();
    stubOpen();
    vi.mocked(api.getNotify).mockResolvedValueOnce(nv()).mockResolvedValueOnce(nv({ available: false, botUsername: null }));
    vi.mocked(api.createTelegramLink).mockRejectedValue(new ApiError(409, { error: 'telegram_unavailable' }));
    render(<NotifySection />);
    await u.click(await screen.findByRole('button', { name: '텔레그램 연결' }));
    expect(await screen.findByText(/관리자에게 텔레그램 봇 설정을 요청하세요\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '텔레그램 연결' })).not.toBeInTheDocument();
  });

  it('휴대폰(굵은 포인터)에서는 빈 탭을 미리 열지 않고 "텔레그램 열기" 링크를 누르게 한다', async () => {
    const u = userEvent.setup();
    const { open } = stubOpen();
    vi.stubGlobal('matchMedia', vi.fn((q: string) => ({ matches: q === '(pointer: coarse)', media: q })));
    vi.mocked(api.getNotify).mockResolvedValue(nv());
    vi.mocked(api.createTelegramLink).mockResolvedValue({
      code: 'AB12CD34', url: `https://t.me/${BOT}?start=AB12CD34`, expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    render(<NotifySection />);
    await u.click(await screen.findByRole('button', { name: '텔레그램 연결' }));
    expect(await screen.findByRole('link', { name: '텔레그램 열기' })).toHaveAttribute('href', `https://t.me/${BOT}?start=AB12CD34`);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('설정 › 알림 · 항목 스위치', () => {
  it('연결되지 않았으면 스위치와 한도 칸이 막혀 있고 까닭을 알린다', async () => {
    vi.mocked(api.getNotify).mockResolvedValue(nv());
    render(<NotifySection />);
    const sw = await screen.findByRole('switch', { name: '작업이 끝났을 때' });
    expect(sw).toBeDisabled();
    expect(sw).toHaveAccessibleDescription(/텔레그램을 연결하면 알림 항목을 고를 수 있습니다\./);
    expect(screen.getByRole('switch', { name: '한도가 80%를 넘을 때' })).toBeDisabled();
    expect(screen.getByLabelText('한도 알림 기준(50~100%)')).toBeDisabled();
    expect(screen.getByText('승인·질문 알림에서는 버튼으로 바로 답할 수 있고, 알림에 답장으로 글을 쓰면 그 세션에 전달됩니다.')).toBeInTheDocument();
  });

  it('바꾸면 바로 저장하고, 실패하면 되돌리고 알린다', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getNotify).mockResolvedValue(linkedView());
    render(<NotifySection />);
    const done = await screen.findByRole('switch', { name: '작업이 끝났을 때' });
    expect(done).toBeChecked();
    await u.click(done);
    expect(api.putNotifySettings).toHaveBeenCalledWith({ ...NOTIFY_DEFAULTS, done: false });
    await waitFor(() => expect(done).not.toBeChecked());

    vi.mocked(api.putNotifySettings).mockRejectedValueOnce(new ApiError(500, {}));
    const lost = screen.getByRole('switch', { name: '연락이 끊겼을 때' });
    await u.click(lost);
    expect(api.putNotifySettings).toHaveBeenLastCalledWith({ ...NOTIFY_DEFAULTS, done: false, lost: false });
    await waitFor(() => expect(lost).toBeChecked());
    expect(screen.getByText('알림 설정을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.')).toBeInTheDocument();
    // 앞서 성공한 값은 그대로 남는다.
    expect(done).not.toBeChecked();
  });

  it('글자(라벨)를 눌러도, 키보드 Space로도 바꿀 수 있다', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getNotify).mockResolvedValue(linkedView());
    render(<NotifySection />);
    await u.click(await screen.findByText('답을 기다릴 때'));
    expect(api.putNotifySettings).toHaveBeenLastCalledWith({ ...NOTIFY_DEFAULTS, wait: false });
    const limit = screen.getByRole('switch', { name: '한도가 80%를 넘을 때' });
    limit.focus();
    await u.keyboard(' ');
    expect(api.putNotifySettings).toHaveBeenLastCalledWith({ ...NOTIFY_DEFAULTS, wait: false, limit: false });
  });

  it('한도 %는 50~100 정수만 저장한다(벗어나면 되돌리고 알린다)', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getNotify).mockResolvedValue(linkedView());
    render(<NotifySection />);
    const pct = await screen.findByLabelText('한도 알림 기준(50~100%)');
    expect(pct).toHaveValue(80);
    expect(pct).toHaveAttribute('min', '50');
    expect(pct).toHaveAttribute('max', '100');

    for (const bad of ['120', '49']) {
      await u.clear(pct);
      await u.type(pct, bad);
      await u.tab();
      expect(await screen.findByText('한도 기준에는 50부터 100까지의 정수를 넣어 주세요.')).toBeInTheDocument();
      expect(pct).toHaveValue(80);
    }
    expect(api.putNotifySettings).not.toHaveBeenCalled();

    await u.clear(pct);
    await u.type(pct, '100{Enter}');
    expect(api.putNotifySettings).toHaveBeenCalledWith({ ...NOTIFY_DEFAULTS, limitPct: 100 });
    expect(await screen.findByRole('switch', { name: '한도가 100%를 넘을 때' })).toBeInTheDocument();

    await u.clear(pct);
    await u.type(pct, '50');
    await u.tab();
    expect(api.putNotifySettings).toHaveBeenLastCalledWith({ ...NOTIFY_DEFAULTS, limitPct: 50 });
  });

  it('한도 % 저장이 실패하면 칸도 원래 값으로 돌아간다', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getNotify).mockResolvedValue(linkedView({ limitPct: 85 }));
    vi.mocked(api.putNotifySettings).mockRejectedValueOnce(new ApiError(500, {}));
    render(<NotifySection />);
    const pct = await screen.findByLabelText('한도 알림 기준(50~100%)');
    await u.clear(pct);
    await u.type(pct, '90{Enter}');
    await waitFor(() => expect(pct).toHaveValue(85));
    expect(screen.getByRole('switch', { name: '한도가 85%를 넘을 때' })).toBeInTheDocument();
  });
});

describe('설정 › 알림 · 연결됨', () => {
  it('시험 메시지를 보내고 결과를 알린다', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getNotify).mockResolvedValue(linkedView());
    render(<NotifySection />);
    await u.click(await screen.findByRole('button', { name: '시험 메시지 보내기' }));
    expect(api.sendTelegramTest).toHaveBeenCalled();
    expect(await screen.findByText('시험 메시지를 보냈습니다. 텔레그램을 확인해 주세요.')).toBeInTheDocument();
  });

  it('시험 메시지가 409 not_linked면 연결 안 됨으로 바꾼다', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getNotify).mockResolvedValueOnce(linkedView()).mockResolvedValueOnce(nv());
    vi.mocked(api.sendTelegramTest).mockRejectedValueOnce(new ApiError(409, { error: 'not_linked' }));
    render(<NotifySection />);
    await u.click(await screen.findByRole('button', { name: '시험 메시지 보내기' }));
    expect(await screen.findByText('텔레그램이 연결되어 있지 않습니다. 다시 연결해 주세요.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '텔레그램 연결' })).toBeInTheDocument();
  });

  it('연결 끊기는 한 번 더 눌러 확인하고, 끊으면 스위치가 막힌다', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getNotify).mockResolvedValue(linkedView());
    vi.mocked(api.unlinkTelegram).mockResolvedValue(nv());
    render(<NotifySection />);
    const sec = await region();
    expect(await within(sec).findByText('연결됨')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: '연결 끊기' }));
    expect(api.unlinkTelegram).not.toHaveBeenCalled();
    await u.click(screen.getByRole('button', { name: '끊기 확인' }));
    expect(api.unlinkTelegram).toHaveBeenCalled();
    expect(await screen.findByText('텔레그램 연결을 끊었습니다.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '텔레그램 연결' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '답을 기다릴 때' })).toBeDisabled();
    expect(within(sec).getByText('연결 안 됨')).toBeInTheDocument();
  });

  it('연결 끊기가 실패하면 연결된 채로 두고 알린다', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getNotify).mockResolvedValue(linkedView());
    vi.mocked(api.unlinkTelegram).mockRejectedValue(new ApiError(500, {}));
    render(<NotifySection />);
    await u.click(await screen.findByRole('button', { name: '연결 끊기' }));
    await u.click(screen.getByRole('button', { name: '끊기 확인' }));
    expect(await screen.findByText('연결을 끊지 못했습니다. 잠시 뒤 다시 시도해 주세요.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '시험 메시지 보내기' })).toBeInTheDocument();
  });
});

describe('관리 › 알림(텔레그램 봇)', () => {
  const TOKEN = '1234567890:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ';
  const off: AdminTelegramView = {
    configured: false, botUsername: null, tokenHint: null, updatedAt: null, polling: 'off', lastError: null, linkedUsers: 0,
  };
  const on: AdminTelegramView = {
    configured: true, botUsername: BOT, tokenHint: 'OpQQ', updatedAt: new Date().toISOString(), polling: 'ok', lastError: null, linkedUsers: 3,
  };

  it('관리 메뉴에 "알림"이 있고, 봇이 없으면 토큰 칸과 만드는 법을 보인다', async () => {
    vi.mocked(api.getAdminTelegram).mockResolvedValue(off);
    render(<AdminUsers me={meOf('admin')} />);
    expect(screen.getByRole('navigation', { name: '관리 메뉴' })).toHaveTextContent('알림');
    const sec = await region();
    const input = await within(sec).findByLabelText('텔레그램 봇 토큰');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAccessibleDescription('@BotFather에서 만든 봇의 토큰입니다. 저장하면 다시 보이지 않습니다.');
    expect(within(sec).getByRole('link', { name: '@BotFather' })).toHaveAttribute('href', 'https://t.me/BotFather');
    expect(within(sec).getByText('/newbot')).toBeInTheDocument();
    expect(within(sec).getAllByRole('listitem')).toHaveLength(3);
  });

  it('토큰을 저장하면 칸을 비우고 봇 상태를 보인다', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getAdminTelegram).mockResolvedValue(off);
    vi.mocked(api.putAdminTelegram).mockResolvedValue(on);
    render(<AdminUsers me={meOf('admin')} />);
    await u.type(await screen.findByLabelText('텔레그램 봇 토큰'), TOKEN);
    await u.click(screen.getByRole('button', { name: '저장' }));
    expect(api.putAdminTelegram).toHaveBeenCalledWith(TOKEN);
    expect(await screen.findByText(`@${BOT} 봇을 저장했습니다.`)).toBeInTheDocument();
    expect(screen.queryByLabelText('텔레그램 봇 토큰')).not.toBeInTheDocument();
    expect(screen.getByText('••••OpQQ')).toBeInTheDocument();
    expect(screen.getByText('3명')).toBeInTheDocument();
    // 토큰 전체는 화면 어디에도 없다.
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('400 invalid_token이면 "텔레그램이 이 토큰을 받아 주지 않습니다"', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getAdminTelegram).mockResolvedValue(off);
    vi.mocked(api.putAdminTelegram).mockRejectedValue(new ApiError(400, { error: 'invalid_token' }));
    render(<AdminUsers me={meOf('admin')} />);
    await u.type(await screen.findByLabelText('텔레그램 봇 토큰'), TOKEN);
    await u.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText(/텔레그램이 이 토큰을 받아 주지 않습니다/)).toBeInTheDocument();
    expect(screen.getByLabelText('텔레그램 봇 토큰')).toBeInTheDocument();
  });

  it('꼴이 틀린 토큰은 서버에 보내지 않는다', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getAdminTelegram).mockResolvedValue(off);
    render(<AdminUsers me={meOf('admin')} />);
    await u.type(await screen.findByLabelText('텔레그램 봇 토큰'), 'abc{Enter}');
    expect(await screen.findByText(/토큰 꼴이 맞지 않습니다/)).toBeInTheDocument();
    expect(api.putAdminTelegram).not.toHaveBeenCalled();
  });

  it('받기 오류면 "오류"와 마지막 오류를 보이고, 토큰 바꾸기·봇 끄기', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getAdminTelegram).mockResolvedValue({ ...on, polling: 'error', lastError: '409 Conflict: 다른 곳에서 받는 중' });
    vi.mocked(api.deleteAdminTelegram).mockResolvedValue({ ...off, linkedUsers: 3 });
    render(<AdminUsers me={meOf('admin')} />);
    const sec = await region();
    expect(await within(sec).findByText('409 Conflict: 다른 곳에서 받는 중')).toBeInTheDocument();
    expect(within(sec).getAllByText('오류').length).toBeGreaterThan(0);

    await u.click(within(sec).getByRole('button', { name: '토큰 바꾸기' }));
    expect(within(sec).getByLabelText('텔레그램 봇 토큰')).toHaveValue('');
    await u.click(within(sec).getByRole('button', { name: '취소' }));
    expect(within(sec).queryByLabelText('텔레그램 봇 토큰')).not.toBeInTheDocument();

    await u.click(within(sec).getByRole('button', { name: '봇 끄기' }));
    expect(api.deleteAdminTelegram).not.toHaveBeenCalled();
    await u.click(within(sec).getByRole('button', { name: '끄기 확인' }));
    expect(api.deleteAdminTelegram).toHaveBeenCalled();
    expect(await within(sec).findByText(/봇을 껐습니다\./)).toBeInTheDocument();
    expect(within(sec).getByLabelText('텔레그램 봇 토큰')).toBeInTheDocument();
  });

  it('관리자가 아니면 봇 설정을 부르지 않는다', () => {
    render(<AdminUsers me={meOf('user')} />);
    expect(api.getAdminTelegram).not.toHaveBeenCalled();
  });
});
