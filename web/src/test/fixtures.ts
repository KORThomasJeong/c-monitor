// 테스트 전용 가짜 데이터 생성기.
import type { AccountView, LogLine, MachineView, SessionView } from '@c-monitor/shared';

export const mkSession = (o: Partial<SessionView> & { id: string }): SessionView => ({
  machineId: 'm1', account: 'dev@company-a.example', cwd: `/home/u/${o.id}`, name: o.id,
  branch: 'main', model: 'Opus 5.5', status: 'run', seen: true,
  startedAt: '2026-11-14T00:00:00Z', lastEventAt: '2026-11-14T00:10:00Z', endedAt: null,
  activity: null, pending: null, canReply: false, queuedMessages: 0, remoteUrl: null, ...o,
});

export const mkMachine = (o: Partial<MachineView> & { id: string }): MachineView => ({
  name: o.id, os: 'Ubuntu', pluginVersion: '0.1.0', lastSeenAt: null, online: true, remoteReply: true, ...o,
});

export const mkAccount = (o: Partial<AccountView> & { email: string }): AccountView => ({
  alias: null, hidden: false, fiveHourPct: 10, fiveHourResetsAt: null, sevenDayPct: 20,
  sevenDayResetsAt: null, at: null, history: [], ...o,
});

export const mkLine = (seq: number, o: Partial<LogLine> = {}): LogLine => ({
  seq, role: 'assistant', at: '2026-11-14T00:00:00Z', text: `줄 ${seq}`, ...o,
});
