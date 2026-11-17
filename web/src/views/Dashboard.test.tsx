import { NOTIFY_DEFAULTS, type LogLine, type LogResponse, type MeResponse, type NotifyView, type StreamMessage } from '@c-monitor/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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
  getLog: vi.fn(),
  searchLog: vi.fn(),
  deleteSession: vi.fn(async () => ({ ok: true })),
  getNotify: vi.fn(),
  patchSession: vi.fn(),
  getPushSubscriptions: vi.fn(),
  getReplies: vi.fn(),
  getHistory: vi.fn(),
  getAdminUsers: vi.fn(),
  getShares: vi.fn(),
  createShare: vi.fn(),
  deleteShare: vi.fn(),
}));
vi.mock('../lib/sound', async (orig) => ({
  ...(await orig<typeof import('../lib/sound')>()),
  playChime: vi.fn(() => true),
}));

const me: MeResponse = { user: { id: 'u1', email: 'admin@example.com', name: null, role: 'admin', status: 'active', consentedAt: '2026-11-01T00:00:00Z', deleteAt: null } };
let handlers: StreamHandlers;

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

type Snapshot = Extract<StreamMessage, { type: 'snapshot' }>;
const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  type: 'snapshot',
  machines: [mkMachine({ id: 'm1', name: '집 PC', os: 'Windows 11' }), mkMachine({ id: 'm2', name: 'server-b' })],
  accounts: [mkAccount({ email: 'dev@company-a.example' })],
  sessions: [
    mkSession({ id: 'run1', name: 'c-monitor', machineId: 'm1', status: 'run', startedAt: ago(12), lastEventAt: ago(0) }),
    mkSession({ id: 'wait1', name: 'search-api', machineId: 'm1', status: 'wait', seen: false,
      activity: { label: 'Bash 실행 승인 요청', text: 'git push origin main' }, startedAt: ago(42), lastEventAt: ago(1) }),
    mkSession({ id: 'done1', name: 'notes-sync', machineId: 'm1', status: 'done', seen: false, startedAt: ago(30), lastEventAt: ago(4) }),
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
const cardNames = (el: HTMLElement) =>
  [...el.querySelectorAll('button.card')].map((b) => b.getAttribute('aria-label')?.split(' · ')[0]);
const panel = () => screen.getByRole('complementary', { name: '세션 상세' });

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => mkLine(from + i));
/** 서버 응답 모양. 앞뒤 더 있는지는 seq로 셈한다. */
function page(lines: LogLine[], total: number): LogResponse {
  return {
    lines, total,
    hasMoreBefore: lines.length > 0 && lines[0]!.seq > 0,
    hasMoreAfter: lines.length > 0 && lines[lines.length - 1]!.seq < total - 1,
  };
}
/** total줄짜리 세션을 흉내 내는 getLog. */
function longLog(total = 250, patch: (l: LogLine) => LogLine = (l) => l) {
  const all = range(0, total - 1).map(patch);
  return async (_id: string, c?: api.LogCursor): Promise<LogResponse> => {
    if (!c) return page(all.slice(-100), total);
    if ('before' in c) return page(all.filter((l) => l.seq < c.before).slice(-100), total);
    if ('after' in c) return page(all.filter((l) => l.seq > c.after).slice(0, 100), total);
    const from = Math.max(0, Math.min(total - 100, c.around - 50));
    return page(all.slice(from, from + 100), total);
  };
}

const notifyOf = (tg: Partial<NotifyView['telegram']> = {}): NotifyView => ({
  telegram: { available: true, botUsername: 'c_monitor_test_bot', linked: true, linkedName: '@hong', linkedAt: null, ...tg },
  settings: NOTIFY_DEFAULTS,
});

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.mocked(connectStream).mockImplementation((h) => { handlers = h; return () => {}; });
  vi.mocked(api.markSeen).mockClear();
  vi.mocked(api.getLog).mockReset().mockResolvedValue(page([], 0));
  vi.mocked(api.searchLog).mockReset().mockResolvedValue({ hits: [], total: 0 });
  vi.mocked(api.deleteSession).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(api.getNotify).mockReset().mockResolvedValue(notifyOf());
  vi.mocked(api.patchSession).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.getPushSubscriptions).mockReset().mockResolvedValue([]);
  vi.mocked(api.getReplies).mockReset().mockResolvedValue([]);
  vi.mocked(api.getHistory).mockReset().mockResolvedValue({ sessions: [], machines: [], accounts: [] });
  vi.mocked(api.getAdminUsers).mockReset().mockResolvedValue([]);
  vi.mocked(api.getShares).mockReset().mockResolvedValue([]);
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
    expect(api.getLog).toHaveBeenCalledWith('wait1');
  });

  it('done 카드는 눌러도 unack가 유지되고 markSeen을 부르지 않는다', async () => {
    const { user } = setup();
    expect(card(/^notes-sync · /)).toHaveClass('card', 's-done', 'unack');
    await user.click(card(/^notes-sync · /));
    expect(card(/^notes-sync · /)).toHaveClass('unack', 'sel');
    expect(api.markSeen).not.toHaveBeenCalled();
  });

  it('done 카드는 상세의 "알람 끄기"를 눌러야 깜박임이 멈춘다', async () => {
    const { user } = setup();
    await user.click(card(/^notes-sync · /));
    await user.click(screen.getByRole('button', { name: '알람 끄기' }));
    expect(api.markSeen).toHaveBeenCalledWith('done1');
    expect(card(/^notes-sync · /)).not.toHaveClass('unack');
    expect(screen.queryByRole('button', { name: '알람 끄기' })).not.toBeInTheDocument();
  });

  it('이미 알람을 끈 done 카드는 깜박이지 않고 버튼도 없다', async () => {
    const { user } = setup(snapshot({ sessions: [mkSession({ id: 'd2', name: 'acked', status: 'done', seen: true })] }));
    expect(card(/^acked · /)).not.toHaveClass('unack');
    await user.click(card(/^acked · /));
    expect(screen.queryByRole('button', { name: '알람 끄기' })).not.toBeInTheDocument();
  });

  it('limit은 빨강(s-wait) 카드에 "한도 초과" 태그', () => {
    setup();
    const c = card(/^blog-site · /);
    expect(c).toHaveClass('s-wait');
    expect(within(c).getByText('한도 초과')).toBeInTheDocument();
  });

  it('컴퓨터별로 묶고 묶음 안은 STATUS_RANK 순서', () => {
    setup();
    expect(cardNames(screen.getByRole('region', { name: '집 PC' }))).toEqual(['search-api', 'notes-sync', 'c-monitor']);
    expect(cardNames(screen.getByRole('region', { name: 'server-b' }))).toEqual(['blog-site', 'homepage']);
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
    vi.mocked(api.getLog).mockResolvedValue(page([
      mkLine(0, { role: 'user', text: '푸시해 줘' }),
      mkLine(1, { role: 'assistant', text: '푸시하겠습니다', truncated: true }),
      mkLine(2, { role: 'tool', text: '', toolName: 'Bash', toolInput: { command: 'cat .env' }, masked: 2 }),
    ], 3));
    const { user } = setup();
    await user.click(card(/^search-api · /));
    const p = panel();
    expect(await within(p).findByText('푸시해 줘')).toBeInTheDocument();
    expect(within(p).getByText('푸시하겠습니다')).toBeInTheDocument();
    expect(within(p).getByText('일부 생략')).toBeInTheDocument();
    expect(within(p).getByText('Bash')).toBeInTheDocument();
    expect(within(p).getByText('cat .env')).toBeInTheDocument();
    expect(within(p).getByText('키 2개 가려짐')).toBeInTheDocument();
    expect(within(p).getByText(/해당 컴퓨터의 터미널에서 답해 주세요/)).toBeInTheDocument();
    expect(within(p).getByText('git push origin main')).toBeInTheDocument();
    // 원격 답장은 이번 범위가 아니다.
    expect(within(p).queryByRole('textbox')).not.toBeInTheDocument();

    // 스트림으로 온 줄은 이어 붙는다.
    act(() => handlers.onMessage({ type: 'log', sessionId: 'wait1', lines: [mkLine(3, { text: '새 줄' })] }));
    expect(within(p).getByText('새 줄')).toBeInTheDocument();

    // 도구 탭에는 도구 줄만.
    await user.click(within(p).getByRole('tab', { name: /도구/ }));
    expect(within(p).queryByText('푸시해 줘')).not.toBeInTheDocument();
    expect(within(p).getByText('cat .env')).toBeInTheDocument();
  });

  it('도구 명령은 한 번만 보이고, 여러 줄 본문은 펼쳐서 본다', async () => {
    vi.mocked(api.getLog).mockResolvedValue(page([
      mkLine(0, { role: 'tool', toolName: 'Bash', text: 'npm test -- rank', toolInput: { command: 'npm test -- rank' } }),
      mkLine(1, { role: 'tool', toolName: 'Bash', text: ' ✓ score.test.ts (12 tests)\n\n Tests  12 passed (12)' }),
    ], 2));
    const { user } = setup();
    await user.click(card(/^search-api · /));
    const p = panel();
    expect(await within(p).findAllByText('npm test -- rank')).toHaveLength(1);
    expect(within(p).getByText('✓ score.test.ts (12 tests)')).toBeInTheDocument();
    expect(within(p).queryByText(/Tests 12 passed/)).not.toBeInTheDocument();
    const more = within(p).getByRole('button', { name: '펼치기' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await user.click(more);
    expect(within(p).getByText(/Tests 12 passed/)).toBeInTheDocument();
    expect(within(p).getByRole('button', { name: '접기' })).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('대화 페이지', () => {
  it('최근 100줄만 불러오고, "이전 대화 더 보기"로 100줄씩 앞을 붙인다', async () => {
    vi.mocked(api.getLog).mockImplementation(longLog(250));
    const { user } = setup();
    await user.click(card(/^search-api · /));
    const p = panel();
    expect(await within(p).findByText('전체 250줄 중 100줄')).toBeInTheDocument();
    expect(within(p).getByText('줄 249')).toBeInTheDocument();
    expect(within(p).queryByText('줄 149')).not.toBeInTheDocument();
    // 일부만 불러왔으니 탭 숫자는 뺀다.
    expect(within(p).getByRole('tab', { name: '대화' })).toBeInTheDocument();

    await user.click(within(p).getByRole('button', { name: '이전 대화 더 보기' }));
    expect(api.getLog).toHaveBeenLastCalledWith('wait1', { before: 150 });
    expect(await within(p).findByText('줄 50')).toBeInTheDocument();
    expect(within(p).getByText('전체 250줄 중 200줄')).toBeInTheDocument();

    await user.click(within(p).getByRole('button', { name: '이전 대화 더 보기' }));
    expect(await within(p).findByText('줄 0')).toBeInTheDocument();
    expect(within(p).queryByRole('button', { name: '이전 대화 더 보기' })).not.toBeInTheDocument();
  });

  it('전체를 다 불러왔으면 탭에 정확한 수를 보인다', async () => {
    vi.mocked(api.getLog).mockResolvedValue(page([
      mkLine(0, { role: 'user', text: '질문' }), mkLine(1, { text: '답' }), mkLine(2, { role: 'tool', toolName: 'Read', text: 'a.ts' }),
    ], 3));
    const { user } = setup();
    await user.click(card(/^search-api · /));
    expect(await within(panel()).findByRole('tab', { name: '대화 2' })).toBeInTheDocument();
    expect(within(panel()).getByRole('tab', { name: '도구 1' })).toBeInTheDocument();
    expect(within(panel()).queryByText(/^전체 \d+줄 중/)).not.toBeInTheDocument();
  });

  it('다시 연결되면 최신에 붙어 있는 대화만 마지막 줄 뒤부터 채운다', async () => {
    vi.mocked(api.getLog).mockImplementation(longLog(250));
    const { user } = setup();
    await user.click(card(/^search-api · /));
    await within(panel()).findByText('줄 249');
    act(() => handlers.onMessage(snapshot()));
    await waitFor(() => expect(api.getLog).toHaveBeenLastCalledWith('wait1', { after: 249 }));
  });
});

describe('대화 검색', () => {
  const hits = [
    { seq: 240, role: 'assistant' as const, at: '2026-11-14T00:00:00Z', snippet: 'git push origin main 을 실행합니다' },
    { seq: 20, role: 'tool' as const, at: '2026-11-14T00:00:00Z', toolName: 'Bash', snippet: 'git push --force' },
  ];
  async function openLong() {
    vi.mocked(api.getLog).mockImplementation(longLog(250, (l) =>
      l.seq === 20 ? { ...l, text: '그 다음 git push --force 실행' } : l.seq === 240 ? { ...l, text: 'git push origin main 을 실행합니다' } : l));
    vi.mocked(api.searchLog).mockResolvedValue({ hits, total: 2 });
    const r = setup();
    await r.user.click(card(/^search-api · /));
    await within(panel()).findByText('줄 249');
    return r;
  }
  const box = () => within(panel()).getByRole('searchbox', { name: '대화 검색' });

  it('Enter로 세션 전체에서 찾고, 결과를 누르면 그 줄로 범위를 옮겨 강조한다', async () => {
    const { user, container } = await openLong();
    await user.type(box(), 'push{Enter}');
    expect(api.searchLog).toHaveBeenCalledWith('wait1', 'push');
    expect(await within(panel()).findByText('2건')).toBeInTheDocument();
    const list = within(panel()).getByRole('list', { name: '검색 결과' });
    expect(within(list).getAllByRole('button')).toHaveLength(2);
    expect(list.querySelector('mark')).toHaveTextContent('push');

    await user.click(within(list).getByRole('button', { name: /git push --force/ }));
    expect(api.getLog).toHaveBeenLastCalledWith('wait1', { around: 20 });
    await waitFor(() => expect(container.querySelector('[data-seq="20"]')).toHaveClass('hit'));
    expect(container.querySelector('[data-seq="20"] mark')).toHaveTextContent('push');

    // 과거를 보는 중에는 새 줄을 붙이지 않고 알려 준다.
    act(() => handlers.onMessage({ type: 'log', sessionId: 'wait1', lines: [mkLine(250, { text: '새 줄' })] }));
    expect(within(panel()).queryByText('새 줄')).not.toBeInTheDocument();
    await user.click(within(panel()).getByRole('button', { name: '새 대화 1줄 · 최신으로' }));
    expect(api.getLog).toHaveBeenLastCalledWith('wait1');
  });

  it('이전·다음 결과 버튼으로 옮겨 다닌다(불러온 범위 안이면 다시 부르지 않는다)', async () => {
    const { user, container } = await openLong();
    await user.type(box(), 'push{Enter}');
    await within(panel()).findByText('2건');
    const calls = vi.mocked(api.getLog).mock.calls.length;
    await user.click(within(panel()).getByRole('button', { name: '이전 결과' }));
    await waitFor(() => expect(container.querySelector('[data-seq="240"]')).toHaveClass('hit'));
    expect(vi.mocked(api.getLog).mock.calls.length).toBe(calls);
    await user.click(within(panel()).getByRole('button', { name: '이전 결과' }));
    await waitFor(() => expect(container.querySelector('[data-seq="20"]')).toHaveClass('hit'));
    expect(within(panel()).getByRole('button', { name: '이전 결과' })).toBeDisabled();
    await user.click(within(panel()).getByRole('button', { name: '다음 결과' }));
    expect(api.getLog).toHaveBeenLastCalledWith('wait1', { around: 240 });
  });

  it('좁은 화면에서는 결과를 고르면 목록을 접고 "목록"으로 다시 편다', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('max-width:1023px'), media: q, addEventListener() {}, removeEventListener() {},
    }));
    try {
      const { user } = await openLong();
      await user.type(box(), 'push{Enter}');
      const list = await within(panel()).findByRole('list', { name: '검색 결과' });
      await user.click(within(list).getByRole('button', { name: /git push origin main/ }));
      expect(within(panel()).queryByRole('list', { name: '검색 결과' })).not.toBeInTheDocument();
      const toggle = within(panel()).getByRole('button', { name: '목록' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await user.click(toggle);
      expect(within(panel()).getByRole('list', { name: '검색 결과' })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('입력을 멈추면 300ms 뒤 찾고, 2자 미만이면 요청하지 않는다', async () => {
    const { user } = await openLong();
    await user.type(box(), 'p');
    await new Promise((r) => setTimeout(r, 400));
    expect(api.searchLog).not.toHaveBeenCalled();
    await user.type(box(), 'u');
    await waitFor(() => expect(api.searchLog).toHaveBeenCalledWith('wait1', 'pu'));
  });

  it('없으면 "찾은 대화가 없습니다", 많으면 "최근 50건만 표시"', async () => {
    const { user } = await openLong();
    vi.mocked(api.searchLog).mockResolvedValueOnce({ hits: [], total: 0 });
    await user.type(box(), 'zz{Enter}');
    expect(await within(panel()).findByText('찾은 대화가 없습니다')).toBeInTheDocument();
    vi.mocked(api.searchLog).mockResolvedValue({ hits, total: 75 });
    await user.clear(box());
    await user.type(box(), 'git{Enter}');
    expect(await within(panel()).findByText('75건')).toBeInTheDocument();
    expect(within(panel()).getByText('최근 50건만 표시')).toBeInTheDocument();
  });

  it('Esc나 × 버튼으로 지우면 결과와 강조가 사라진다', async () => {
    const { user, container } = await openLong();
    await user.type(box(), 'push{Enter}');
    await user.click(await within(panel()).findByRole('button', { name: /git push origin main/ }));
    await waitFor(() => expect(container.querySelector('.hit')).not.toBeNull());
    await user.type(box(), '{Escape}');
    expect(box()).toHaveValue('');
    expect(within(panel()).queryByRole('list', { name: '검색 결과' })).not.toBeInTheDocument();
    expect(container.querySelector('.hit')).toBeNull();
    expect(container.querySelector('.log mark')).toBeNull();

    await user.type(box(), 'push{Enter}');
    await within(panel()).findByText('2건');
    await user.click(within(panel()).getByRole('button', { name: '검색 지우기' }));
    expect(box()).toHaveValue('');
    expect(within(panel()).queryByText('2건')).not.toBeInTheDocument();
  });
});

describe('세션 지우기', () => {
  it('종료·끊김 카드에만 지우기 버튼이 있고, 누르면 확인 없이 바로 사라진다(카드는 열리지 않음)', async () => {
    const base = snapshot();
    const lost = mkSession({ id: 'lost1', name: 'old-job', machineId: 'm2', status: 'lost', lastEventAt: ago(30) });
    const { user } = setup({ ...base, sessions: [...base.sessions, lost] });
    const home = screen.getByRole('region', { name: '집 PC' });
    expect(within(home).queryByRole('button', { name: '세션 지우기' })).not.toBeInTheDocument();
    const server = screen.getByRole('region', { name: 'server-b' });
    const dels = within(server).getAllByRole('button', { name: '세션 지우기' });
    expect(dels).toHaveLength(2);
    expect(dels[0]).toHaveAttribute('title', '세션과 대화 기록을 지웁니다');

    await user.click(dels[0]!);
    expect(api.deleteSession).toHaveBeenCalledTimes(1);
    expect(within(server).getAllByRole('button', { name: '세션 지우기' })).toHaveLength(1);
    expect(api.getLog).not.toHaveBeenCalled();
    expect(within(panel()).getByText(/카드를 누르면/)).toBeInTheDocument();
  });

  it('서버가 실패하면 되돌리고 짧은 오류를 보인다', async () => {
    vi.mocked(api.deleteSession).mockRejectedValue(new api.ApiError(409, { error: 'session_active' }));
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: '세션 지우기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('세션을 지우지 못했습니다');
    expect(card(/^homepage · /)).toBeInTheDocument();
  });

  it('상세 패널 머리에서도 지우고 상세를 닫는다', async () => {
    const { user } = setup();
    await user.click(card(/^homepage · /));
    await user.click(within(panel()).getByRole('button', { name: '세션 지우기' }));
    expect(api.deleteSession).toHaveBeenCalledWith('end1');
    expect(within(panel()).getByText(/카드를 누르면/)).toBeInTheDocument();
  });

  it('실시간 removed 메시지로 지워지면 보고 있던 상세도 닫힌다', async () => {
    const { user } = setup();
    await user.click(card(/^homepage · /));
    expect(within(panel()).getByText('homepage')).toBeInTheDocument();
    act(() => handlers.onMessage({ type: 'removed', sessionIds: ['end1'] }));
    expect(screen.queryByRole('button', { name: /^homepage · / })).not.toBeInTheDocument();
    expect(within(panel()).getByText(/카드를 누르면/)).toBeInTheDocument();
  });

  it('간단히 보기 타일에서도 지운다(상세로 넘어가지 않는다)', async () => {
    localStorage.setItem('cs-mode', 'deck');
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: '세션 지우기' }));
    expect(api.deleteSession).toHaveBeenCalledWith('end1');
    expect(screen.queryByRole('button', { name: /^homepage · / })).not.toBeInTheDocument();
    expect(localStorage.getItem('cs-mode')).toBe('deck');
  });
});

describe('컴퓨터 묶음', () => {
  it('세션이 없는 컴퓨터도 묶음 머리를 보이고, 상태 필터를 걸면 숨긴다', async () => {
    const base = snapshot();
    const { user } = setup({ ...base, machines: [...base.machines, mkMachine({ id: 'm3', name: '새 노트북', os: 'darwin' })] });
    const g = screen.getByRole('region', { name: '새 노트북' });
    expect(within(g).getByText('세션이 없습니다')).toBeInTheDocument();
    // PC 아이콘(모니터 모양)
    expect(g.querySelector('.g-ico rect')?.getAttribute('height')).toBe('14');
    await user.click(screen.getByRole('button', { name: /^종료/ }));
    expect(screen.queryByRole('region', { name: '새 노트북' })).not.toBeInTheDocument();
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

describe('세션별 알림 스위치(텔레그램·웹 공통)', () => {
  it('상세 머리의 스위치로 바로 끄고, 카드에 "알림 끔" 표시가 붙는다', async () => {
    const { user } = setup();
    await user.click(card(/^c-monitor · /));
    const p = panel();
    const sw = await within(p).findByRole('switch', { name: '알림' });
    expect(sw).toBeChecked();
    expect(screen.queryByTestId('tg-off')).not.toBeInTheDocument();
    await user.click(sw);
    expect(api.patchSession).toHaveBeenCalledWith('run1', { telegram: false });
    expect(sw).not.toBeChecked();
    const c = card(/^c-monitor · /);
    expect(c).toHaveAccessibleName('c-monitor · 작업 중 · 알림 끔');
    expect(within(c).getByTestId('tg-off')).toHaveAttribute('title', '알림 끔');
  });

  it('저장이 실패하면 되돌리고 알린다', async () => {
    vi.mocked(api.patchSession).mockRejectedValueOnce(new api.ApiError(500, {}));
    const { user } = setup();
    await user.click(card(/^c-monitor · /));
    const sw = await within(panel()).findByRole('switch', { name: '알림' });
    await user.click(sw);
    await waitFor(() => expect(sw).toBeChecked());
    expect(await screen.findByText('알림 설정을 바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요.')).toBeInTheDocument();
    expect(screen.queryByTestId('tg-off')).not.toBeInTheDocument();
  });

  it('서버가 돌려준 세션으로 맞춘다(켜기)', async () => {
    const s = snapshot();
    s.sessions[0] = { ...s.sessions[0]!, telegram: false };
    vi.mocked(api.patchSession).mockImplementation(async (id, b) => ({ session: { ...s.sessions[0]!, id, telegram: b.telegram } }));
    const { user } = setup(s);
    expect(within(card(/^c-monitor · /)).getByTestId('tg-off')).toBeInTheDocument();
    await user.click(card(/^c-monitor · /));
    const sw = await within(panel()).findByRole('switch', { name: '알림' });
    expect(sw).not.toBeChecked();
    await user.click(sw);
    expect(api.patchSession).toHaveBeenCalledWith('run1', { telegram: true });
    await waitFor(() => expect(screen.queryByTestId('tg-off')).not.toBeInTheDocument());
  });

  it('텔레그램도 웹 알림도 없으면 스위치를 막고 설정으로 안내한다', async () => {
    vi.mocked(api.getNotify).mockResolvedValue(notifyOf({ linked: false, linkedName: null }));
    const { user } = setup();
    await user.click(card(/^c-monitor · /));
    const sw = await within(panel()).findByRole('switch', { name: '알림' });
    expect(sw).toBeDisabled();
    expect(sw).toHaveAccessibleDescription(/텔레그램을 연결하거나 웹 알림을 켜면 쓸 수 있습니다/);
    expect(within(panel()).getByRole('link', { name: '설정 › 알림' })).toHaveAttribute('href', '/settings#notify');
  });

  it('공유받은 세션에는 스위치도 "알림 끔" 표시도 없다', async () => {
    const s = snapshot();
    s.sessions[0] = { ...s.sessions[0]!, sharedBy: 'owner@example.com', telegram: false };
    const { user } = setup(s);
    // 공유받은 세션에는 "알림 끔" 표시도 없다(내 설정이 아니다).
    expect(within(card(/^c-monitor · /)).queryByTestId('tg-off')).not.toBeInTheDocument();
    await user.click(card(/^c-monitor · /));
    await waitFor(() => expect(api.getNotify).toHaveBeenCalled());
    expect(within(panel()).queryByRole('switch', { name: '알림' })).not.toBeInTheDocument();

    // 내 세션에는 있다.
    await user.click(card(/^search-api · /));
    expect(await within(panel()).findByRole('switch', { name: '알림' })).toBeInTheDocument();
  });

  it('봇이 없어도 웹 알림을 켠 브라우저가 있으면 스위치를 쓸 수 있다', async () => {
    vi.mocked(api.getNotify).mockResolvedValue(notifyOf({ available: false, botUsername: null, linked: false }));
    vi.mocked(api.getPushSubscriptions).mockResolvedValue([{ endpoint: 'https://push.example/1', label: 'Chrome · Windows', createdAt: ago(5) }]);
    const { user } = setup();
    await user.click(card(/^c-monitor · /));
    const sw = await within(panel()).findByRole('switch', { name: '알림' });
    await waitFor(() => expect(sw).toBeEnabled());
    expect(sw).toBeChecked();
    await user.click(sw);
    expect(api.patchSession).toHaveBeenCalledWith('run1', { telegram: false });
  });

  it('알림 설정을 하나도 못 불러오면 스위치를 그리지 않는다', async () => {
    vi.mocked(api.getNotify).mockRejectedValue(new api.ApiError(500, {}));
    vi.mocked(api.getPushSubscriptions).mockRejectedValue(new api.ApiError(500, {}));
    const { user } = setup();
    await user.click(card(/^c-monitor · /));
    await waitFor(() => expect(api.getPushSubscriptions).toHaveBeenCalled());
    await act(async () => {});
    expect(within(panel()).queryByRole('switch', { name: '알림' })).not.toBeInTheDocument();
  });
});
