import type { MeResponse, UserView } from '@c-monitor/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { App } from '../App';
import { mkAccount, mkMachine } from '../test/fixtures';
import { AdminUsers } from './AdminUsers';
import { ConnectApprove } from './ConnectApprove';
import { Login } from './Login';
import { Pending } from './Pending';
import { Settings } from './Settings';

vi.mock('../api/stream', () => ({ connectStream: vi.fn(() => () => {}) }));
vi.mock('../api/client', async (orig) => {
  const real = await orig<typeof import('../api/client')>();
  return {
    ...real,
    getMe: vi.fn(),
    getDashboard: vi.fn(),
    getSettings: vi.fn(),
    putSettings: vi.fn(async () => undefined),
    patchAccount: vi.fn(async () => undefined),
    revokeMachine: vi.fn(async () => undefined),
    approveDevice: vi.fn(),
    lookupDevice: vi.fn(),
    denyDevice: vi.fn(async () => ({ ok: true })),
    getAdminUsers: vi.fn(),
    approveUser: vi.fn(async () => undefined),
    suspendUser: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
  };
});

const user = (o: Partial<UserView> = {}): UserView => ({
  id: 'u1', email: 'admin@example.com', name: '관리자', role: 'admin', status: 'active', ...o,
});
const meOf = (o: Partial<UserView> = {}): MeResponse => ({ user: user(o) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.lookupDevice).mockResolvedValue({ userCode: 'K7QM-2XPA', machineName: '집 PC', os: 'win32' });
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('로그인', () => {
  it('Gmail 로그인은 /auth/google로 가고 가입 고지를 보인다', () => {
    render(<Login />);
    expect(screen.getByRole('link', { name: /Gmail 계정으로 로그인/ })).toHaveAttribute('href', '/auth/google');
    expect(screen.getByText(/가입을 신청하면 관리자가 승인한 뒤 사용할 수 있습니다\. 관리자는 서비스 운영을 위해 저장된 대화를 볼 수 있습니다\./)).toBeInTheDocument();
  });

  it('돌아갈 주소가 있으면 next로 넘긴다', () => {
    window.history.replaceState(null, '', '/login?next=%2Fconnect%3Fcode%3DAB12-CD34');
    render(<Login />);
    expect(screen.getByRole('link', { name: /Gmail 계정으로 로그인/ }))
      .toHaveAttribute('href', '/auth/google?next=%2Fconnect%3Fcode%3DAB12-CD34');
  });
});

describe('승인 대기', () => {
  it('안내 문구와 로그아웃', async () => {
    const u = userEvent.setup();
    render(<Pending />);
    expect(screen.getByText('가입 신청을 받았습니다. 관리자가 승인하면 사용할 수 있습니다.')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: '로그아웃' }));
    expect(api.logout).toHaveBeenCalled();
    await waitFor(() => expect(window.location.pathname).toBe('/login'));
  });
});

describe('승인 대기 · 돌아갈 주소', () => {
  it('연결 링크로 들어왔으면 그 링크를 보여 주고, 승인되면 그리로 돌아간다', async () => {
    const u = userEvent.setup();
    window.history.replaceState(null, '', '/pending?next=%2Fconnect%3Fcode%3DK7QM-2XPA');
    render(<Pending />);
    expect(screen.getByText('승인을 받은 뒤 아래 링크를 다시 열어 주세요.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /\/connect\?code=K7QM-2XPA/ })).toHaveAttribute('href', '/connect?code=K7QM-2XPA');
    vi.mocked(api.getMe).mockResolvedValue(meOf({ status: 'active' }));
    await u.click(screen.getByRole('button', { name: '승인 확인' }));
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe('/connect?code=K7QM-2XPA'));
  });

  it('바깥 주소는 돌아갈 곳으로 받지 않는다', () => {
    window.history.replaceState(null, '', '/pending?next=%2F%2Fevil.example');
    render(<Pending />);
    expect(screen.queryByText('승인을 받은 뒤 아래 링크를 다시 열어 주세요.')).not.toBeInTheDocument();
  });

  it('로그아웃해도 돌아갈 주소를 로그인 화면에 넘긴다', async () => {
    const u = userEvent.setup();
    window.history.replaceState(null, '', '/pending?next=%2Fconnect%3Fcode%3DK7QM-2XPA');
    render(<Pending />);
    await u.click(screen.getByRole('button', { name: '로그아웃' }));
    await waitFor(() => expect(window.location.pathname).toBe('/login'));
    expect(new URLSearchParams(window.location.search).get('next')).toBe('/connect?code=K7QM-2XPA');
  });
});

describe('연결 승인', () => {
  it('어떤 컴퓨터인지(이름·운영체제) 보여 준다', async () => {
    render(<ConnectApprove me={meOf()} code="K7QM-2XPA" />);
    expect(api.lookupDevice).toHaveBeenCalledWith('K7QM-2XPA');
    expect(await screen.findByText('집 PC')).toBeInTheDocument();
    expect(screen.getByText('win32')).toBeInTheDocument();
  });

  it('조회가 404면(만료·이미 처리) 승인 버튼 대신 안내를 보인다', async () => {
    vi.mocked(api.lookupDevice).mockRejectedValue(new ApiError(404, { error: 'not_found' }));
    render(<ConnectApprove me={meOf()} code="K7QM-2XPA" />);
    expect(await screen.findByRole('heading', { name: '연결하지 못했습니다' })).toBeInTheDocument();
    expect(screen.getByText(/만료되었거나 이미 처리된 코드입니다/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '연결 승인' })).not.toBeInTheDocument();
  });

  it('거부하면 서버에 알리고 안내를 보인다', async () => {
    const u = userEvent.setup();
    render(<ConnectApprove me={meOf()} code="K7QM-2XPA" />);
    await screen.findByText('집 PC');
    await u.click(screen.getByRole('button', { name: '거부' }));
    expect(api.denyDevice).toHaveBeenCalledWith('K7QM-2XPA');
    expect(await screen.findByText('연결을 거부했습니다. 터미널의 연결 요청은 취소됩니다.')).toBeInTheDocument();
  });

  it('거부가 404면 이미 처리된 요청이라고 알린다', async () => {
    const u = userEvent.setup();
    vi.mocked(api.denyDevice).mockRejectedValue(new ApiError(404, { error: 'not_found' }));
    render(<ConnectApprove me={meOf()} code="K7QM-2XPA" />);
    await screen.findByText('집 PC');
    await u.click(screen.getByRole('button', { name: '거부' }));
    expect(await screen.findByText(/이미 처리된 연결 요청입니다/)).toBeInTheDocument();
  });

  it('코드를 보여 주고 승인하면 성공 화면', async () => {
    const u = userEvent.setup();
    vi.mocked(api.approveDevice).mockResolvedValue({ machineName: '집 PC' });
    render(<ConnectApprove me={meOf()} code="k7qm2xpa" />);
    expect(screen.getByText('K7QM-2XPA')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: '연결 승인' }));
    expect(api.approveDevice).toHaveBeenCalledWith('K7QM-2XPA');
    expect(await screen.findByRole('heading', { name: '연결했습니다' })).toBeInTheDocument();
    expect(screen.getByText(/집 PC의 세션이 이제 대시보드에 나타납니다/)).toBeInTheDocument();
  });

  it('만료된 코드면 실패 화면', async () => {
    const u = userEvent.setup();
    vi.mocked(api.approveDevice).mockRejectedValue(new ApiError(410, { error: 'expired' }));
    render(<ConnectApprove me={meOf()} code="K7QM-2XPA" />);
    await u.click(screen.getByRole('button', { name: '연결 승인' }));
    expect(await screen.findByRole('heading', { name: '연결하지 못했습니다' })).toBeInTheDocument();
    expect(screen.getByText(/만료되었거나 이미 처리된 코드입니다/)).toBeInTheDocument();
  });

  it('코드가 없으면 입력칸을 보여 준다', async () => {
    const u = userEvent.setup();
    render(<ConnectApprove me={meOf()} code={null} />);
    await u.type(screen.getByLabelText('연결 코드'), 'ab12cd34');
    await u.click(screen.getByRole('button', { name: '확인' }));
    expect(window.location.search).toBe('?code=AB12-CD34');
  });
});

describe('설정', () => {
  beforeEach(() => {
    vi.mocked(api.getDashboard).mockResolvedValue({
      sessions: [],
      machines: [mkMachine({ id: 'm1', name: '집 PC', os: 'Windows 11', online: true }), mkMachine({ id: 'm2', name: 'server-b', online: false })],
      accounts: [mkAccount({ email: 'dev@company-a.example' }), mkAccount({ email: 'dev@company-b.example', alias: '에코', hidden: true })],
    });
    vi.mocked(api.getSettings).mockResolvedValue({ lostMinutes: 10, endHours: 24, keepChatDays: 30, keepUsageDays: 90 });
  });

  it('컴퓨터·계정·기준·보관을 보여 주고 바꾼 것만 저장한다', async () => {
    const u = userEvent.setup();
    render(<Settings me={meOf()} />);
    const machines = await screen.findByRole('region', { name: '내 컴퓨터' });
    expect(within(machines).getByText('집 PC')).toBeInTheDocument();
    expect(within(machines).getByText('오프라인')).toBeInTheDocument();

    const alias = screen.getByLabelText('dev@company-a.example 별칭');
    await u.type(alias, '회사');
    await u.click(screen.getByRole('switch', { name: 'dev@company-b.example 숨기기' }));
    const lost = screen.getByLabelText('연락 끊김으로 표시');
    await u.clear(lost);
    await u.type(lost, '15');

    await u.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(api.putSettings).toHaveBeenCalledWith({ lostMinutes: 15, endHours: 24, keepChatDays: 30, keepUsageDays: 90 }));
    expect(api.patchAccount).toHaveBeenCalledWith('dev@company-a.example', { alias: '회사' });
    expect(api.patchAccount).toHaveBeenCalledWith('dev@company-b.example', { hidden: false });
    expect(api.patchAccount).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('저장했습니다.')).toBeInTheDocument();
  });

  it('입력 범위는 서버와 같다(종료 카드 유지는 0~8760시간, 별칭 60자)', async () => {
    const u = userEvent.setup();
    render(<Settings me={meOf()} />);
    await screen.findByRole('region', { name: '내 컴퓨터' });
    expect(screen.getByText('시간 뒤 목록에서 숨깁니다')).toBeInTheDocument();
    expect(screen.queryByText(/기록 탭/)).not.toBeInTheDocument();
    const end = screen.getByLabelText('종료 카드 유지');
    expect(end).toHaveAttribute('min', '0');
    expect(end).toHaveAttribute('max', '8760');
    expect(screen.getByLabelText('dev@company-a.example 별칭')).toHaveAttribute('maxLength', '60');

    await u.clear(end);
    await u.type(end, '0');
    await u.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(api.putSettings).toHaveBeenCalledWith({ lostMinutes: 10, endHours: 0, keepChatDays: 30, keepUsageDays: 90 }));

    vi.mocked(api.putSettings).mockClear();
    await u.clear(end);
    await u.type(end, '8761');
    await u.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText('종료 카드 유지에는 0부터 8760까지의 정수를 넣어 주세요.')).toBeInTheDocument();
    expect(api.putSettings).not.toHaveBeenCalled();
  });

  it('연결 해제는 한 번 더 눌러 확인한다', async () => {
    const u = userEvent.setup();
    render(<Settings me={meOf()} />);
    const machines = await screen.findByRole('region', { name: '내 컴퓨터' });
    const row = within(machines).getByText('집 PC').closest('tr')!;
    await u.click(within(row).getByRole('button', { name: '연결 해제' }));
    expect(api.revokeMachine).not.toHaveBeenCalled();
    await u.click(within(row).getByRole('button', { name: '해제 확인' }));
    expect(api.revokeMachine).toHaveBeenCalledWith('m1');
    await waitFor(() => expect(within(machines).queryByText('집 PC')).not.toBeInTheDocument());
  });
});

describe('관리자', () => {
  it('승인 대기 목록에서 승인하고, 사용자를 정지한다', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getAdminUsers).mockResolvedValue([
      user(),
      user({ id: 'u2', email: 'new@gmail.com', role: 'user', status: 'pending' }),
      user({ id: 'u3', email: 'old@gmail.com', role: 'user', status: 'active' }),
    ]);
    render(<AdminUsers me={meOf()} />);
    const pending = await screen.findByRole('region', { name: '승인 대기' });
    const row = within(pending).getByText('new@gmail.com').closest('tr')!;
    await u.click(within(row).getByRole('button', { name: '승인' }));
    expect(api.approveUser).toHaveBeenCalledWith('u2');

    const users = screen.getByRole('region', { name: '사용자' });
    const old = within(users).getByText('old@gmail.com').closest('tr')!;
    await u.click(within(old).getByRole('button', { name: '정지' }));
    expect(api.suspendUser).toHaveBeenCalledWith('u3');
    // 자기 자신은 정지할 수 없다.
    const self = within(users).getByText('admin@example.com').closest('tr')!;
    expect(within(self).queryByRole('button', { name: '정지' })).not.toBeInTheDocument();
  });

  it('관리자가 아니면 막는다', () => {
    render(<AdminUsers me={meOf({ role: 'user' })} />);
    expect(screen.getByText('관리자만 볼 수 있는 화면입니다.')).toBeInTheDocument();
    expect(api.getAdminUsers).not.toHaveBeenCalled();
  });
});

describe('라우팅', () => {
  it('주소에 따라 화면을 고르고 Link로 옮겨 다닌다', async () => {
    const u = userEvent.setup();
    vi.mocked(api.getMe).mockResolvedValue(meOf());
    vi.mocked(api.getDashboard).mockResolvedValue({ sessions: [], machines: [], accounts: [] });
    vi.mocked(api.getSettings).mockResolvedValue({ lostMinutes: 10, endHours: 24, keepChatDays: 30, keepUsageDays: 90 });
    render(<App />);
    expect(await screen.findByRole('heading', { name: '세션 현황' })).toBeInTheDocument();
    await u.click(screen.getByRole('link', { name: '설정' }));
    expect(window.location.pathname).toBe('/settings');
    expect(await screen.findByRole('heading', { name: '설정' })).toBeInTheDocument();
  });

  it('/login은 로그인 확인 없이 바로 보인다', () => {
    window.history.replaceState(null, '', '/login');
    render(<App />);
    expect(screen.getByRole('link', { name: /Gmail 계정으로 로그인/ })).toBeInTheDocument();
    expect(api.getMe).not.toHaveBeenCalled();
  });

  it('승인 대기 사용자가 연결 링크로 오면 코드를 잃지 않고 /pending으로 보낸다', async () => {
    window.history.replaceState(null, '', '/connect?code=K7QM-2XPA');
    vi.mocked(api.getMe).mockResolvedValue(meOf({ status: 'pending', role: 'user' }));
    render(<App />);
    await waitFor(() => expect(window.location.pathname).toBe('/pending'));
    expect(new URLSearchParams(window.location.search).get('next')).toBe('/connect?code=K7QM-2XPA');
    expect(await screen.findByText('승인을 받은 뒤 아래 링크를 다시 열어 주세요.')).toBeInTheDocument();
  });

  it('승인 대기 사용자는 /pending으로 보낸다', async () => {
    vi.mocked(api.getMe).mockResolvedValue(meOf({ status: 'pending', role: 'user' }));
    render(<App />);
    await waitFor(() => expect(window.location.pathname).toBe('/pending'));
    expect(await screen.findByText('가입 신청을 받았습니다. 관리자가 승인하면 사용할 수 있습니다.')).toBeInTheDocument();
  });
});
