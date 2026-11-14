import { describe, expect, it } from 'vitest';
import { IngestBatchSchema, isLost, nextStatus } from '../src/index';

const ev = (event: string, data: Record<string, unknown> = {}) => ({ event, data }) as never;

describe('nextStatus', () => {
  it('질문 입력·도구 실행은 작업 중', () => {
    expect(nextStatus(null, ev('UserPromptSubmit'))).toBe('run');
    expect(nextStatus('done', ev('UserPromptSubmit'))).toBe('run');
    expect(nextStatus('wait', ev('PreToolUse', { tool_name: 'Bash' }))).toBe('run');
    expect(nextStatus('wait', ev('PostToolUse', { tool_name: 'Bash' }))).toBe('run');
    expect(nextStatus('run', ev('SubagentStop'))).toBe('run');
  });

  it('세션 시작은 진행 중이 아니면 끝남(입력 대기)으로 둔다', () => {
    expect(nextStatus(null, ev('SessionStart'))).toBe('done');
    expect(nextStatus('end', ev('SessionStart'))).toBe('done');
    expect(nextStatus('run', ev('SessionStart'))).toBe('run');
  });

  it('승인·질문 알림은 기다림', () => {
    expect(nextStatus('run', ev('Notification', { notification_type: 'permission_prompt' }))).toBe('wait');
    expect(nextStatus('run', ev('Notification', { notification_type: 'elicitation_dialog' }))).toBe('wait');
    expect(nextStatus('run', ev('Notification', { notification_type: 'agent_needs_input' }))).toBe('wait');
    expect(nextStatus('run', ev('PreToolUse', { tool_name: 'AskUserQuestion' }))).toBe('wait');
  });

  it('그 밖의 알림은 상태를 바꾸지 않는다', () => {
    expect(nextStatus('done', ev('Notification', { notification_type: 'idle_prompt' }))).toBe('done');
    expect(nextStatus('run', ev('Notification', { notification_type: 'auth_success' }))).toBe('run');
    expect(nextStatus(null, ev('Notification', { notification_type: 'idle_prompt' }))).toBe('done');
  });

  it('Stop은 끝남, 한도 초과는 limit, 그 밖의 실패는 끝남', () => {
    expect(nextStatus('run', ev('Stop'))).toBe('done');
    expect(nextStatus('run', ev('StopFailure', { error: 'rate_limit' }))).toBe('limit');
    expect(nextStatus('run', ev('StopFailure', { error: 'server_error' }))).toBe('done');
  });

  it('SessionEnd는 종료', () => {
    expect(nextStatus('run', ev('SessionEnd'))).toBe('end');
  });
});

describe('isLost', () => {
  const t = new Date('2026-11-14T10:00:00Z');
  const plus = (m: number) => new Date(t.getTime() + m * 60_000);

  it('작업 중인데 기준 시간보다 오래 조용하면 끊김', () => {
    expect(isLost('run', t, plus(11), 10)).toBe(true);
    expect(isLost('run', t, plus(9), 10)).toBe(false);
  });

  it('작업 중이 아닌 상태는 끊김으로 보지 않는다', () => {
    expect(isLost('wait', t, plus(60), 10)).toBe(false);
    expect(isLost('done', t, plus(60), 10)).toBe(false);
    expect(isLost('end', t, plus(60), 10)).toBe(false);
  });
});

describe('IngestBatchSchema', () => {
  const base = {
    machine: { name: '집 PC', os: 'Windows 11', pluginVersion: '0.1.0' },
    events: [{
      id: '8c1f6c1e-6f0a-4d7e-9a53-0d6d2f5b9a10', sessionId: 's1', event: 'Stop',
      at: '2026-11-14T10:00:00.000Z', account: 'a@example.com', cwd: 'C:\\work\\x',
      branch: null, model: null, data: {},
    }],
    transcript: [{ sessionId: 's1', seq: 0, lines: [{ role: 'user', at: '2026-11-14T10:00:00.000Z', text: '안녕' }] }],
  };

  it('올바른 묶음은 통과하고 limits는 생략할 수 있다', () => {
    expect(IngestBatchSchema.safeParse(base).success).toBe(true);
  });

  it('모르는 이벤트 이름과 잘못된 퍼센트는 거부한다', () => {
    const badEvent = { ...base, events: [{ ...base.events[0], event: 'Nope' }] };
    expect(IngestBatchSchema.safeParse(badEvent).success).toBe(false);
    const badLimit = { ...base, limits: { account: 'a@example.com', fiveHourPct: 140, fiveHourResetsAt: null, sevenDayPct: 3, sevenDayResetsAt: null, at: '2026-11-14T10:00:00.000Z' } };
    expect(IngestBatchSchema.safeParse(badLimit).success).toBe(false);
  });
});
