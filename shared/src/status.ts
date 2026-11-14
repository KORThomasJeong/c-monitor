// 세션 상태 규칙. 설계 문서 5절과 1:1로 대응한다.
import type { HookEvent, SessionStatus } from './contract';

/** 사용자의 답을 기다리게 만드는 알림 종류 */
const WAIT_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog', 'agent_needs_input']);

/** 이전 상태와 새 훅 이벤트로 다음 상태를 정한다. */
export function nextStatus(
  prev: SessionStatus | null,
  e: Pick<HookEvent, 'event' | 'data'>,
): SessionStatus {
  const data = e.data ?? {};
  switch (e.event) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return 'run';
    case 'PreToolUse':
      return data.tool_name === 'AskUserQuestion' ? 'wait' : 'run';
    case 'SubagentStop':
      // 메인 세션이 답을 기다리는 중에 서브에이전트만 끝난 경우는 그대로 둔다.
      return prev === 'wait' ? 'wait' : 'run';
    case 'Notification':
      if (WAIT_NOTIFICATIONS.has(String(data.notification_type))) return 'wait';
      return prev ?? 'done';
    case 'Stop':
      return 'done';
    case 'StopFailure':
      return data.error === 'rate_limit' ? 'limit' : 'done';
    case 'SessionEnd':
      return 'end';
    case 'SessionStart':
      // 새로 열렸거나 다시 이어 붙은 세션은 입력을 기다리는 상태로 본다.
      return prev === null || prev === 'end' || prev === 'lost' ? 'done' : prev;
    default:
      return prev ?? 'done';
  }
}

/** 작업 중인데 기준 시간(분)보다 오래 이벤트가 없으면 끊김. */
export function isLost(
  status: SessionStatus,
  lastEventAt: Date,
  now: Date,
  lostMinutes: number,
): boolean {
  if (status !== 'run') return false;
  return now.getTime() - lastEventAt.getTime() > lostMinutes * 60_000;
}

/** 화면 정렬 순서: 기다림 → 한도 초과 → 끝남 → 작업 중 → 끊김 → 종료 */
export const STATUS_RANK: Record<SessionStatus, number> = {
  wait: 0, limit: 1, done: 2, run: 3, lost: 4, end: 5,
};

export const STATUS_LABEL: Record<SessionStatus, string> = {
  wait: '답변 기다림',
  limit: '한도 초과',
  done: '작업 끝남',
  run: '작업 중',
  lost: '연락 끊김',
  end: '종료',
};
