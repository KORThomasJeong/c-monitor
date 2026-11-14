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

describe('연결 승인', () => {
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
    expect(screen.getByText(/코드가 만료되었거나 맞지 않습니다/)).toBeInTheDocument();
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

  it('승인 대기 사용자는 /pending으로 보낸다', async () => {
    vi.mocked(api.getMe).mockResolvedValue(meOf({ status: 'pending', role: 'user' }));
    render(<App />);
    await waitFor(() => expect(window.location.pathname).toBe('/pending'));
    expect(await screen.findByText('가입 신청을 받았습니다. 관리자가 승인하면 사용할 수 있습니다.')).toBeInTheDocument();
  });
});
