import type { MeResponse, StreamMessage } from '@c-monitor/shared';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { connectStream, type StreamHandlers } from '../api/stream';
import { mkAccount, mkLine, mkMachine, mkSession } from '../test/fixtures';
import { Dashboard } from './Dashboard';

vi.mock('../api/stream', () => ({ connectStream: vi.fn() }));
vi.mock('../api/client', async (orig) => ({
  ...(await orig<typeof import('../api/client')>()),
  markSeen: vi.fn(async () => undefined),
  getLog: vi.fn(async () => ({ lines: [] })),
}));

const me: MeResponse = { user: { id: 'u1', email: 'admin@example.com', name: null, role: 'admin', status: 'active' } };
let handlers: StreamHandlers;

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const snapshot = (over: Partial<Extract<StreamMessage, { type: 'snapshot' }>> = {}): StreamMessage => ({
  type: 'snapshot',
  machines: [mkMachine({ id: 'm1', name: '집 PC', os: 'Windows 11' }), mkMachine({ id: 'm2', name: 'server-b' })],
  accounts: [mkAccount({ email: 'dev@company-a.example' })],
  sessions: [
    mkSession({ id: 'run1', name: 'c-monitor', machineId: 'm1', status: 'run', startedAt: ago(12), lastEventAt: ago(0) }),
    mkSession({ id: 'wait1', name: 'search-api', machineId: 'm1', status: 'wait', seen: false,
      activity: { label: 'Bash 실행 승인 요청', text: 'git push origin main' }, startedAt: ago(42), lastEventAt: ago(1) }),
    mkSession({ id: 'done1', name: 'notes-sync', machineId: 'm1', status: 'done', startedAt: ago(30), lastEventAt: ago(4) }),
    mkSession({ id: 'lim1', name: 'blog-site', machineId: 'm2', status: 'limit', startedAt: ago(30), lastEventAt: ago(2) }),
    mkSession({ id: 'end1', name: 'homepage', machineId: 'm2', status: 'end', startedAt: ago(300), lastEventAt: ago(200), endedAt: ago(200) }),
  ],
  ...over,
});

function setup(msg: StreamMessage = snapshot()) {
  const user = userEvent.setup();
  const view = render(<Dashboard me={me} />);
  act(() => {
    handlers.onStatus?.(true);
    handlers.onMessage(msg);
  });
  return { user, ...view };
}
const card = (name: RegExp) => screen.getByRole('button', { name });

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.mocked(connectStream).mockImplementation((h) => { handlers = h; return () => {}; });
  vi.mocked(api.markSeen).mockClear();
  vi.mocked(api.getLog).mockClear().mockResolvedValue({ lines: [] });
});
afterEach(() => vi.clearAllMocks());

describe('대시보드 상세', () => {
  it('wait 카드는 unseen으로 깜박이다가 누르면 멈추고 markSeen을 부른다', async () => {
    const { user } = setup();
    const c = card(/^search-api · /);
    expect(c).toHaveClass('card', 's-wait', 'unseen');
    await user.click(c);
    expect(card(/^search-api · /)).not.toHaveClass('unseen');
    expect(card(/^search-api · /)).toHaveClass('sel');
    expect(api.markSeen).toHaveBeenCalledWith('wait1');
    expect(api.getLog).toHaveBeenCalledWith('wait1', undefined);
  });

  it('done 카드는 눌러도 unack가 유지되고 markSeen을 부르지 않는다', async () => {
    const { user } = setup();
    expect(card(/^notes-sync · /)).toHaveClass('card', 's-done', 'unack');
    await user.click(card(/^notes-sync · /));
    expect(card(/^notes-sync · /)).toHaveClass('unack', 'sel');
    expect(api.markSeen).not.toHaveBeenCalled();
  });

  it('limit은 빨강(s-wait) 카드에 "한도 초과" 태그', () => {
    setup();
    const c = card(/^blog-site · /);
    expect(c).toHaveClass('s-wait');
    expect(within(c).getByText('한도 초과')).toBeInTheDocument();
  });

  it('컴퓨터별로 묶고 묶음 안은 STATUS_RANK 순서', () => {
    setup();
    const home = screen.getByRole('region', { name: '집 PC' });
    const names = within(home).getAllByRole('button').map((b) => b.getAttribute('aria-label')?.split(' · ')[0]);
    expect(names).toEqual(['search-api', 'notes-sync', 'c-monitor']);
    const ora = screen.getByRole('region', { name: 'server-b' });
    expect(within(ora).getAllByRole('button').map((b) => b.getAttribute('aria-label')?.split(' · ')[0]))
      .toEqual(['blog-site', 'homepage']);
  });

  it('상태 필터로 거른다', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: /^끝남/ }));
    expect(screen.getAllByRole('button', { name: / · 작업 끝남$/ })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^search-api · / })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'server-b' })).not.toBeInTheDocument();
  });

  it('연결이 끊기면 "다시 연결 중"', () => {
    setup();
    expect(screen.getByText('실시간 연결됨')).toBeInTheDocument();
    act(() => handlers.onStatus?.(false));
    expect(screen.getByText('다시 연결 중')).toBeInTheDocument();
  });

  it('스트림 session 메시지가 오면 카드가 바뀐다', () => {
    setup();
    act(() => handlers.onMessage({ type: 'session', session: mkSession({ id: 'run1', name: 'c-monitor', machineId: 'm1', status: 'wait', seen: false }) }));
    expect(card(/^c-monitor · /)).toHaveClass('s-wait', 'unseen');
  });
});

describe('한도 카드', () => {
  const accounts = ['a', 'b', 'c', 'd', 'e'].map((x, i) =>
    mkAccount({ email: `${x}@corp.com`, at: ago(i), fiveHourPct: 10 * i }));

  it('계정이 5개면 최근 갱신 4개 카드 + "외 1개"', async () => {
    const { user, container } = setup(snapshot({ accounts }));
    const region = screen.getByRole('region', { name: '계정별 사용 한도' });
    expect(container.querySelectorAll('article.lim')).toHaveLength(4);
    // 가장 오래 갱신 안 된 e가 접힌다.
    expect(within(region).queryByText('e@corp.com')).not.toBeInTheDocument();
    const more = screen.getByRole('button', { name: '외 1개' });
    await user.click(more);
    expect(container.querySelectorAll('article.lim')).toHaveLength(5);
    expect(screen.getByRole('button', { name: '접기' })).toBeInTheDocument();
  });

  it('숨긴 계정은 빼고, 80%·95%를 넘으면 태그를 붙인다', () => {
    const { container } = setup(snapshot({
      accounts: [
        mkAccount({ email: 'x@corp.com', fiveHourPct: 87, sevenDayPct: 96 }),
        mkAccount({ email: 'hidden@corp.com', hidden: true }),
      ],
    }));
    expect(container.querySelectorAll('article.lim')).toHaveLength(1);
    expect(screen.getByText('80% 넘음')).toHaveClass('tag', 'amber');
    expect(screen.getByText('거의 다 씀')).toHaveClass('tag', 'red');
    expect(screen.queryByText('hidden@corp.com')).not.toBeInTheDocument();
  });
});

describe('상세 패널', () => {
  it('대화를 불러와 줄마다 그리고, 가림·생략 표시와 wait 안내를 보인다', async () => {
    vi.mocked(api.getLog).mockResolvedValue({
      lines: [
        mkLine(0, { role: 'user', text: '푸시해 줘' }),
        mkLine(1, { role: 'assistant', text: '푸시하겠습니다', truncated: true }),
        mkLine(2, { role: 'tool', text: '', toolName: 'Bash', toolInput: { command: 'cat .env' }, masked: 2 }),
      ],
    });
    const { user } = setup();
    await user.click(card(/^search-api · /));
    const panel = screen.getByRole('complementary', { name: '세션 상세' });
    expect(await within(panel).findByText('푸시해 줘')).toBeInTheDocument();
    expect(within(panel).getByText('푸시하겠습니다')).toBeInTheDocument();
    expect(within(panel).getByText('일부 생략')).toBeInTheDocument();
    expect(within(panel).getByText('Bash')).toBeInTheDocument();
    expect(within(panel).getByText('cat .env')).toBeInTheDocument();
    expect(within(panel).getByText('키 2개 가려짐')).toBeInTheDocument();
    expect(within(panel).getByText(/해당 컴퓨터의 터미널에서 답해 주세요/)).toBeInTheDocument();
    expect(within(panel).getByText('git push origin main')).toBeInTheDocument();
    // 원격 답장은 이번 범위가 아니다.
    expect(within(panel).queryByRole('textbox')).not.toBeInTheDocument();

    // 스트림으로 온 줄은 이어 붙는다.
    act(() => handlers.onMessage({ type: 'log', sessionId: 'wait1', lines: [mkLine(3, { text: '새 줄' })] }));
    expect(within(panel).getByText('새 줄')).toBeInTheDocument();

    // 도구 탭에는 도구 줄만.
    await user.click(within(panel).getByRole('tab', { name: /도구/ }));
    expect(within(panel).queryByText('푸시해 줘')).not.toBeInTheDocument();
    expect(within(panel).getByText('cat .env')).toBeInTheDocument();
  });
});

describe('간단히 보기', () => {
  it('타일을 누르면 상세 모드로 돌아가고 그 세션이 선택된다', async () => {
    const { user, container } = setup();
    await user.click(screen.getByRole('button', { name: '간단히 보기로' }));
    expect(localStorage.getItem('cs-mode')).toBe('deck');
    const tile = screen.getByRole('button', { name: /^search-api · .*눌러서 상세 보기$/ });
    expect(tile).toHaveClass('tile', 'k-wait', 'unseen');
    expect(screen.getByRole('button', { name: /^notes-sync · / })).toHaveClass('tile', 'k-done', 'unack');
    expect(container.querySelectorAll('.lp').length).toBeGreaterThan(0);

    await user.click(tile);
    expect(localStorage.getItem('cs-mode')).toBe('detail');
    expect(screen.getByRole('heading', { name: '세션 현황' })).toBeInTheDocument();
    expect(card(/^search-api · /)).toHaveClass('sel');
    expect(card(/^search-api · /)).not.toHaveClass('unseen');
    expect(api.markSeen).toHaveBeenCalledWith('wait1');
  });

  it('한도 알약은 2개까지 + "외 N"', async () => {
    const accounts = ['a', 'b', 'c', 'd'].map((x, i) => mkAccount({ email: `${x}@corp.com`, at: ago(i) }));
    localStorage.setItem('cs-mode', 'deck');
    const { container } = setup(snapshot({ accounts }));
    expect(container.querySelectorAll('.lp:not(.lp-more)')).toHaveLength(2);
    expect(screen.getByText('외 2')).toBeInTheDocument();
  });
});

describe('테마', () => {
  it('버튼으로 바꾸면 .app에 dark가 붙고 기억한다', async () => {
    const { user, container } = setup();
    const app = container.querySelector('.app')!;
    const wasDark = app.classList.contains('dark');
    await user.click(screen.getByRole('button', { name: '테마 바꾸기' }));
    expect(app.classList.contains('dark')).toBe(!wasDark);
    expect(localStorage.getItem('cs-theme')).toBe(wasDark ? 'light' : 'dark');
  });
});
