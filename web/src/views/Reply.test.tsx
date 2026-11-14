// 원격 답장(2차) 화면 테스트: 카드·상세의 답 버튼, 글 입력창, 원격 제어 링크, 간단히 보기 타일.
import type { MeResponse, PendingView, ReplyQuestion, SessionView, StreamMessage } from '@c-monitor/shared';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { connectStream, type StreamHandlers } from '../api/stream';
import { mkAccount, mkMachine, mkSession } from '../test/fixtures';
import { Dashboard } from './Dashboard';

vi.mock('../api/stream', () => ({ connectStream: vi.fn() }));
vi.mock('../api/client', async (orig) => ({
  ...(await orig<typeof import('../api/client')>()),
  markSeen: vi.fn(async () => undefined),
  getLog: vi.fn(async () => ({ lines: [], total: 0, hasMoreBefore: false, hasMoreAfter: false })),
  searchLog: vi.fn(async () => ({ hits: [], total: 0 })),
  replyToSession: vi.fn(),
}));

const me: MeResponse = { user: { id: 'u1', email: 'admin@example.com', name: null, role: 'admin', status: 'active', consentedAt: '2026-11-01T00:00:00Z', deleteAt: null } };
let handlers: StreamHandlers;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const permission = (o: Partial<PendingView> = {}): PendingView => ({
  id: 'r1', kind: 'permission', toolName: 'Bash', summary: 'git push origin main',
  sessionAllow: '이 세션 동안 git push 명령은 다시 묻지 않습니다', at: ago(1), more: 0, ...o,
});
const question = (qs: ReplyQuestion[], o: Partial<PendingView> = {}): PendingView => ({
  id: 'q1', kind: 'question', toolName: 'AskUserQuestion', summary: qs[0]!.question, sessionAllow: null,
  questions: qs, at: ago(1), more: 0, ...o,
});
const Q1: ReplyQuestion = {
  question: '글 목록을 어떻게 나눌까요?', header: '목록',
  options: [{ label: '페이지 번호', description: '주소가 /posts/2처럼 나뉩니다' }, { label: '무한 스크롤' }],
};

/** 답할 수 있는 세션(원격 답장 켜진 0.2.0 컴퓨터) */
const live = (o: Partial<SessionView> & { id: string }) =>
  mkSession({ machineId: 'm1', status: 'wait', seen: true, canReply: true, startedAt: ago(30), lastEventAt: ago(1), ...o });

type Snapshot = Extract<StreamMessage, { type: 'snapshot' }>;
function snapshot(sessions: SessionView[], machine = mkMachine({ id: 'm1', name: '집 PC', pluginVersion: '0.2.0' })): Snapshot {
  return { type: 'snapshot', machines: [machine], accounts: [mkAccount({ email: 'dev@company-a.example' })], sessions };
}

function setup(sessions: SessionView[], machine?: ReturnType<typeof mkMachine>) {
  const user = userEvent.setup();
  const view = render(<Dashboard me={me} />);
  act(() => {
    handlers.onStatus?.(true);
    handlers.onMessage(snapshot(sessions, machine));
  });
  return { user, ...view };
}
const push = (session: SessionView) => act(() => handlers.onMessage({ type: 'session', session }));
const group = () => screen.getByRole('region', { name: '집 PC' });
const panel = () => screen.getByRole('complementary', { name: '세션 상세' });
const card = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name} · `) });
/** 카드를 눌러 상세를 연다. */
async function openDetail(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(card(name));
  return panel();
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.mocked(connectStream).mockImplementation((h) => { handlers = h; return () => {}; });
  vi.mocked(api.replyToSession).mockReset().mockResolvedValue({ ok: true, queued: false });
  vi.mocked(api.getLog).mockClear();
});
afterEach(() => vi.clearAllMocks());

describe('승인 답하기', () => {
  it.each([
    ['허용', 'allow'],
    ['이 세션 동안 허용', 'allow_session'],
    ['거부', 'deny'],
  ] as const)('카드의 "%s" 버튼은 behavior=%s 를 보낸다', async (label, behavior) => {
    const { user } = setup([live({ id: 's1', name: 'search-api', pending: permission() })]);
    const box = within(group()).getByRole('group', { name: 'search-api 답하기' });
    expect(within(box).getByText('git push origin main')).toBeInTheDocument();
    expect(within(box).getByText('Bash 실행 승인을 기다립니다')).toBeInTheDocument();
    await user.click(within(box).getByRole('button', { name: label }));
    expect(api.replyToSession).toHaveBeenCalledWith('s1', { type: 'permission', requestId: 'r1', behavior });
  });

  it('카드에서 답 버튼을 눌러도 상세가 열리지 않는다', async () => {
    const { user } = setup([live({ id: 's1', name: 'search-api', pending: permission() })]);
    await user.click(within(group()).getByRole('button', { name: '허용' }));
    expect(card('search-api')).not.toHaveClass('sel');
    expect(api.getLog).not.toHaveBeenCalled();
    expect(screen.getByText(/카드를 누르면 그 세션의 대화가/)).toBeInTheDocument();
  });

  it('sessionAllow가 없으면 가운데 버튼이 없고, 있으면 그 설명을 툴팁·작은 글로 보인다', () => {
    setup([
      live({ id: 's1', name: 'search-api', pending: permission({ sessionAllow: null }) }),
      live({ id: 's2', name: 'blog-site', pending: permission({ id: 'r2' }) }),
    ]);
    const a = within(group()).getByRole('group', { name: 'search-api 답하기' });
    expect(within(a).queryByRole('button', { name: '이 세션 동안 허용' })).not.toBeInTheDocument();
    expect(within(a).getAllByRole('button').map((b) => b.textContent)).toEqual(['허용', '거부']);

    const b = within(group()).getByRole('group', { name: 'blog-site 답하기' });
    const mid = within(b).getByRole('button', { name: '이 세션 동안 허용' });
    expect(mid).toHaveAttribute('title', '이 세션 동안 git push 명령은 다시 묻지 않습니다');
    expect(mid).toHaveAccessibleDescription('이 세션 동안 허용: 이 세션 동안 git push 명령은 다시 묻지 않습니다');
  });

  it('누르면 잠기고, 서버가 pending을 없애면 버튼이 사라진다', async () => {
    let done!: (v: { ok: true; queued: boolean }) => void;
    vi.mocked(api.replyToSession).mockReturnValue(new Promise((r) => { done = r; }));
    const s = live({ id: 's1', name: 'search-api', pending: permission() });
    const { user } = setup([s]);
    const box = () => within(group()).getByRole('group', { name: 'search-api 답하기' });
    await user.click(within(box()).getByRole('button', { name: '허용' }));
    for (const b of within(box()).getAllByRole('button')) expect(b).toBeDisabled();
    expect(within(box()).getByText('보내는 중입니다')).toBeInTheDocument();
    await act(async () => { done({ ok: true, queued: false }); });
    expect(within(box()).getByText('보냈습니다 · 허용')).toBeInTheDocument();
    expect(within(box()).getByRole('button', { name: '거부' })).toBeDisabled();

    push({ ...s, status: 'run', pending: null });
    expect(within(group()).queryByRole('group', { name: 'search-api 답하기' })).not.toBeInTheDocument();
    expect(within(group()).queryByRole('button', { name: '허용' })).not.toBeInTheDocument();
  });

  it('409 no_pending이면 잠금을 풀고 "이미 터미널에서 답했습니다"를 알린다', async () => {
    vi.mocked(api.replyToSession).mockRejectedValue(new ApiError(409, { error: 'no_pending' }));
    const { user } = setup([live({ id: 's1', name: 'search-api', pending: permission() })]);
    const box = within(group()).getByRole('group', { name: 'search-api 답하기' });
    await user.click(within(box).getByRole('button', { name: '거부' }));
    expect(await within(box).findByText('이미 터미널에서 답했습니다')).toBeInTheDocument();
    expect(within(box).getByRole('button', { name: '허용' })).toBeEnabled();
  });

  it('409 reply_disabled면 "이 컴퓨터는 원격 답장이 꺼져 있습니다"', async () => {
    vi.mocked(api.replyToSession).mockRejectedValue(new ApiError(409, { error: 'reply_disabled' }));
    const { user } = setup([live({ id: 's1', name: 'search-api', pending: permission() })]);
    const panelBox = await openDetail(user, 'search-api');
    await user.click(within(panelBox).getByRole('button', { name: '허용' }));
    expect(await within(panelBox).findByRole('alert')).toHaveTextContent('이 컴퓨터는 원격 답장이 꺼져 있습니다');
  });

  it('pending이 사라진 뒤에도 카드에 실패 까닭이 잠시 남는다', async () => {
    vi.mocked(api.replyToSession).mockRejectedValue(new ApiError(409, { error: 'no_pending' }));
    const s = live({ id: 's1', name: 'search-api', pending: permission() });
    const { user } = setup([s]);
    await user.click(within(group()).getByRole('button', { name: '허용' }));
    push({ ...s, status: 'run', pending: null });
    expect(await within(group()).findByText('이미 터미널에서 답했습니다')).toBeInTheDocument();
  });

  it('함께 기다리는 요청이 있으면 "외 N개 대기"', () => {
    setup([live({ id: 's1', name: 'search-api', pending: permission({ more: 2 }) })]);
    expect(within(group()).getByText('외 2개 대기')).toBeInTheDocument();
  });

  it('canReply가 false면 pending이 있어도 답 버튼을 그리지 않는다', () => {
    setup([live({ id: 's1', name: 'search-api', canReply: false, pending: permission() })]);
    expect(within(group()).queryByRole('button', { name: '허용' })).not.toBeInTheDocument();
  });
});

describe('질문 답하기', () => {
  it('질문이 하나이고 단일 선택이면 선택지를 누르는 즉시 보낸다', async () => {
    const { user } = setup([live({ id: 's1', name: 'blog-site', pending: question([Q1]) })]);
    const box = within(group()).getByRole('group', { name: 'blog-site 답하기' });
    expect(within(box).getByText('글 목록을 어떻게 나눌까요?')).toBeInTheDocument();
    expect(within(box).queryByRole('button', { name: /보내기/ })).not.toBeInTheDocument();
    await user.click(within(box).getByRole('button', { name: '무한 스크롤' }));
    expect(api.replyToSession).toHaveBeenCalledWith('s1', {
      type: 'answer', requestId: 'q1', answers: { '글 목록을 어떻게 나눌까요?': '무한 스크롤' },
    });
  });

  it('다중 선택은 고른 뒤 "보내기"로 보내고, 고른 것은 ", "로 잇는다', async () => {
    const multi: ReplyQuestion = { question: '무엇을 넣을까요?', multiSelect: true, options: [{ label: '태그' }, { label: '검색' }, { label: '목차' }] };
    const { user } = setup([live({ id: 's1', name: 'blog-site', pending: question([multi]) })]);
    const box = within(group()).getByRole('group', { name: 'blog-site 답하기' });
    const send = within(box).getByRole('button', { name: '보내기' });
    expect(send).toBeDisabled();
    await user.click(within(box).getByRole('button', { name: '태그' }));
    await user.click(within(box).getByRole('button', { name: '목차' }));
    expect(api.replyToSession).not.toHaveBeenCalled();
    expect(within(box).getByRole('button', { name: '태그' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(send);
    expect(api.replyToSession).toHaveBeenCalledWith('s1', { type: 'answer', requestId: 'q1', answers: { '무엇을 넣을까요?': '태그, 목차' } });
  });

  it('질문이 여러 개면 모두 고른 뒤 "보내기", 상세에서는 질문별 직접 입력', async () => {
    const Q2: ReplyQuestion = { question: '한 쪽에 몇 개씩?', header: '개수', options: [{ label: '10개' }, { label: '20개' }] };
    const { user } = setup([live({ id: 's1', name: 'blog-site', pending: question([Q1, Q2]) })]);
    const p = await openDetail(user, 'blog-site');
    const box = within(p).getByRole('group', { name: 'blog-site 답하기' });
    // 질문이 여러 개면 아래 입력창 대신 질문별 입력칸
    expect(within(p).queryByLabelText('클로드에게 보내기')).not.toBeInTheDocument();
    const send = within(box).getByRole('button', { name: '보내기' });
    await user.click(within(box).getByRole('button', { name: /페이지 번호/ }));
    expect(send).toBeDisabled();
    await user.type(within(box).getByLabelText('개수 직접 입력'), '15개');
    await user.click(send);
    expect(api.replyToSession).toHaveBeenCalledWith('s1', {
      type: 'answer', requestId: 'q1', answers: { '글 목록을 어떻게 나눌까요?': '페이지 번호', '한 쪽에 몇 개씩?': '15개' },
    });
  });
});

describe('글 보내기', () => {
  const box = (p: HTMLElement) => within(p).getByLabelText('클로드에게 보내기');

  it('승인을 기다리는 중이면 "거부하고 글 보내기"', async () => {
    const { user } = setup([live({ id: 's1', name: 'search-api', pending: permission() })]);
    const p = await openDetail(user, 'search-api');
    await user.type(box(p), 'main 말고 dev에 올려 주세요');
    await user.click(within(p).getByRole('button', { name: '거부하고 글 보내기' }));
    expect(api.replyToSession).toHaveBeenCalledWith('s1', {
      type: 'permission', requestId: 'r1', behavior: 'deny', message: 'main 말고 dev에 올려 주세요',
    });
  });

  it('질문 중이면 그 글을 첫 질문의 답으로', async () => {
    const { user } = setup([live({ id: 's1', name: 'blog-site', pending: question([Q1]) })]);
    const p = await openDetail(user, 'blog-site');
    await user.type(box(p), '둘 다 해 보고 정할게요{Enter}');
    expect(api.replyToSession).toHaveBeenCalledWith('s1', {
      type: 'answer', requestId: 'q1', answers: { '글 목록을 어떻게 나눌까요?': '둘 다 해 보고 정할게요' },
    });
  });

  it('평소에는 type:message, Enter로 보내고 Shift+Enter는 줄바꿈, 한글 조합 중 Enter는 보내지 않는다', async () => {
    vi.mocked(api.replyToSession).mockResolvedValue({ ok: true, queued: true });
    const { user } = setup([live({ id: 's1', name: 'c-monitor', status: 'run' })]);
    const p = await openDetail(user, 'c-monitor');
    const ta = box(p);
    expect(ta).toHaveAttribute('maxLength', '4000');
    await user.type(ta, '첫 줄{Shift>}{Enter}{/Shift}둘째 줄');
    expect(ta).toHaveValue('첫 줄\n둘째 줄');
    fireEvent.keyDown(ta, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(ta, { key: 'Enter', keyCode: 229 });
    expect(api.replyToSession).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(api.replyToSession).toHaveBeenCalledWith('s1', { type: 'message', text: '첫 줄\n둘째 줄' });
    expect(ta).toHaveValue('');
    expect(await within(p).findByText('작업이 끝나면 전달됩니다 (1개 대기)')).toBeInTheDocument();
  });

  it('서버가 알려 준 대기 수(queuedMessages)를 보인다', async () => {
    const { user } = setup([live({ id: 's1', name: 'c-monitor', status: 'run', queuedMessages: 3 })]);
    const p = await openDetail(user, 'c-monitor');
    expect(within(p).getByText('작업이 끝나면 전달됩니다 (3개 대기)')).toBeInTheDocument();
  });

  it('빈 글은 보내지 않는다', async () => {
    const { user } = setup([live({ id: 's1', name: 'c-monitor', status: 'done' })]);
    const p = await openDetail(user, 'c-monitor');
    expect(within(p).getByRole('button', { name: '보내기' })).toBeDisabled();
    await user.type(box(p), '   {Enter}');
    expect(api.replyToSession).not.toHaveBeenCalled();
  });

  it('보내기에 실패하면 글을 남겨 두고 까닭을 보인다', async () => {
    vi.mocked(api.replyToSession).mockRejectedValue(new ApiError(500, {}));
    const { user } = setup([live({ id: 's1', name: 'c-monitor', status: 'done' })]);
    const p = await openDetail(user, 'c-monitor');
    await user.type(box(p), '다음 작업{Enter}');
    expect(await within(p).findByRole('alert')).toHaveTextContent('보내지 못했습니다');
    expect(box(p)).toHaveValue('다음 작업');
  });

  it('canReply가 false면 입력창이 없고, 까닭(스위치 꺼짐·플러그인 낮음)을 보인다', async () => {
    const { user, unmount } = setup(
      [live({ id: 's1', name: 'c-monitor', status: 'done', canReply: false })],
      mkMachine({ id: 'm1', name: '집 PC', pluginVersion: '0.2.0', remoteReply: false }),
    );
    let p = await openDetail(user, 'c-monitor');
    expect(within(p).queryByLabelText('클로드에게 보내기')).not.toBeInTheDocument();
    expect(within(p).getByRole('note')).toHaveTextContent('이 컴퓨터는 원격 답장이 꺼져 있습니다');
    unmount();

    const again = setup(
      [live({ id: 's1', name: 'c-monitor', status: 'done', canReply: false })],
      mkMachine({ id: 'm1', name: '집 PC', pluginVersion: '0.1.3', remoteReply: true }),
    );
    p = await openDetail(again.user, 'c-monitor');
    expect(within(p).queryByLabelText('클로드에게 보내기')).not.toBeInTheDocument();
    expect(within(p).getByRole('note')).toHaveTextContent('플러그인을 0.2.0 이상으로 업데이트');
  });

  it('종료·끊김 세션에는 입력창도 까닭도 보이지 않는다', async () => {
    const { user } = setup([
      live({ id: 's1', name: 'old-one', status: 'end', canReply: false, endedAt: ago(5) }),
      live({ id: 's2', name: 'gone-one', status: 'lost', canReply: false }),
    ]);
    for (const name of ['old-one', 'gone-one']) {
      const p = await openDetail(user, name);
      expect(within(p).queryByLabelText('클로드에게 보내기')).not.toBeInTheDocument();
      expect(within(p).queryByRole('note')).not.toBeInTheDocument();
      expect(within(p).queryByText(/remote-control/)).not.toBeInTheDocument();
    }
  });
});

describe('원격 제어 링크', () => {
  it('remoteUrl이 있으면 상세에 "원격 제어로 열기"(새 탭)', async () => {
    const { user } = setup([live({ id: 's1', name: 'c-monitor', status: 'run', remoteUrl: 'https://claude.ai/code/session_abc123' })]);
    expect(within(group()).queryByRole('link', { name: /원격 제어로 열기/ })).not.toBeInTheDocument();
    const p = await openDetail(user, 'c-monitor');
    const a = within(p).getByRole('link', { name: '원격 제어로 열기' });
    expect(a).toHaveAttribute('href', 'https://claude.ai/code/session_abc123');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(p).queryByText(/을 실행하면 원격 제어 링크가 생깁니다/)).not.toBeInTheDocument();
  });

  it('없으면 버튼 대신 상세에만 작은 안내, 공식 주소가 아니면 링크로 쓰지 않는다', async () => {
    const { user } = setup([
      live({ id: 's1', name: 'c-monitor', status: 'run' }),
      live({ id: 's2', name: 'odd-one', status: 'run', remoteUrl: 'javascript:alert(1)' }),
    ]);
    expect(within(group()).queryByText(/remote-control/)).not.toBeInTheDocument();
    let p = await openDetail(user, 'c-monitor');
    expect(within(p).queryByRole('link', { name: /원격 제어로 열기/ })).not.toBeInTheDocument();
    expect(within(p).getByText('/remote-control')).toBeInTheDocument();
    p = await openDetail(user, 'odd-one');
    expect(within(p).queryByRole('link', { name: /원격 제어로 열기/ })).not.toBeInTheDocument();
  });
});

describe('간단히 보기', () => {
  it('답할 수 있는 타일은 "눌러서 답하기"가 보이고, 누르면 상세에서 답한다', async () => {
    localStorage.setItem('cs-mode', 'deck');
    const { user } = setup([
      live({ id: 's1', name: 'search-api', pending: permission(), seen: false }),
      live({ id: 's2', name: 'c-monitor', status: 'run' }),
    ]);
    const tile = screen.getByRole('button', { name: 'search-api · 답변 기다림 · 승인 대기 · 눌러서 답하기' });
    expect(tile).toHaveClass('tile', 'k-wait', 'unseen', 'can-reply');
    expect(screen.getByRole('button', { name: 'c-monitor · 작업 중 · 눌러서 상세 보기' })).toBeInTheDocument();
    await user.click(tile);
    const p = panel();
    await user.click(within(p).getByRole('button', { name: '허용' }));
    expect(api.replyToSession).toHaveBeenCalledWith('s1', { type: 'permission', requestId: 'r1', behavior: 'allow' });
  });
});
