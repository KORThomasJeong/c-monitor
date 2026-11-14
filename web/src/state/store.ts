// 대시보드 상태. 스트림 메시지를 순수 함수 applyMessage로 합친다.
import type {
  AccountView,
  LogLine,
  MachineView,
  SessionView,
  StreamMessage,
} from '@c-monitor/shared';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import * as api from '../api/client';
import { connectStream } from '../api/stream';

export type DashboardState = {
  sessions: SessionView[];
  machines: MachineView[];
  accounts: AccountView[];
  /** 세션별 대화 줄(seq 오름차순, 중복 없음) */
  logs: Record<string, LogLine[]>;
  /** 첫 snapshot을 받았는지 */
  loaded: boolean;
};

export const emptyState: DashboardState = { sessions: [], machines: [], accounts: [], logs: {}, loaded: false };

function upsert<T>(list: T[], item: T, same: (a: T) => boolean): T[] {
  const i = list.findIndex(same);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

/** seq 기준으로 중복 없이 합친다. 늦게 온 빠진 줄도 제자리에 들어간다. */
export function mergeLines(prev: LogLine[] | undefined, incoming: LogLine[]): LogLine[] {
  if (incoming.length === 0) return prev ?? [];
  const base = prev ?? [];
  const last = base.length ? base[base.length - 1]!.seq : -1;
  // 대부분은 뒤에 이어 붙는 경우라 빠른 길을 먼저 본다.
  let inOrder = true;
  let p = last;
  for (const l of incoming) {
    if (l.seq <= p) { inOrder = false; break; }
    p = l.seq;
  }
  if (inOrder) return base.concat(incoming);
  const bySeq = new Map<number, LogLine>();
  for (const l of base) bySeq.set(l.seq, l);
  for (const l of incoming) if (!bySeq.has(l.seq)) bySeq.set(l.seq, l);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function applyMessage(state: DashboardState, msg: StreamMessage): DashboardState {
  switch (msg.type) {
    case 'snapshot': {
      // 통째로 바꾼다. 로그는 스냅샷에 없으니 아직 있는 세션 것만 남긴다(빠진 줄은 다시 불러 채움).
      const alive = new Set(msg.sessions.map((s) => s.id));
      const logs: Record<string, LogLine[]> = {};
      for (const [id, lines] of Object.entries(state.logs)) if (alive.has(id)) logs[id] = lines;
      return { sessions: msg.sessions, machines: msg.machines, accounts: msg.accounts, logs, loaded: true };
    }
    case 'session':
      return { ...state, sessions: upsert(state.sessions, msg.session, (s) => s.id === msg.session.id) };
    case 'machine':
      return { ...state, machines: upsert(state.machines, msg.machine, (m) => m.id === msg.machine.id) };
    case 'limits':
      return { ...state, accounts: upsert(state.accounts, msg.account, (a) => a.email === msg.account.email) };
    case 'log':
      return { ...state, logs: { ...state.logs, [msg.sessionId]: mergeLines(state.logs[msg.sessionId], msg.lines) } };
    default:
      return state;
  }
}

/** 카드를 연 즉시 화면에서 seen=true로 바꾼다(서버 응답을 기다리지 않음). */
export function markSeenLocal(state: DashboardState, sessionId: string): DashboardState {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s || s.seen) return state;
  return applyMessage(state, { type: 'session', session: { ...s, seen: true } });
}

type Action = StreamMessage | { type: 'seen'; sessionId: string };
const reducer = (s: DashboardState, a: Action) => (a.type === 'seen' ? markSeenLocal(s, a.sessionId) : applyMessage(s, a));

export type Dashboard = DashboardState & {
  connected: boolean;
  /** 화면에서 바로 seen 처리하고 서버에 알린다. */
  markSeen: (sessionId: string) => void;
  /** 대화를 불러온다(이미 받은 줄 뒤부터). */
  loadLog: (sessionId: string) => Promise<void>;
};

export function useDashboard(): Dashboard {
  const [state, dispatch] = useReducer(reducer, emptyState);
  const [connected, setConnected] = useState(false);
  const ref = useRef(state);
  ref.current = state;

  const loadLog = useCallback(async (sessionId: string) => {
    const lines = ref.current.logs[sessionId];
    const after = lines?.length ? lines[lines.length - 1]!.seq : undefined;
    try {
      const res = await api.getLog(sessionId, after);
      dispatch({ type: 'log', sessionId, lines: res?.lines ?? [] });
    } catch {
      // "불러오는 중"에 머물지 않게 빈 목록으로 표시. 이후 줄은 스트림으로 이어 붙는다.
      dispatch({ type: 'log', sessionId, lines: [] });
    }
  }, []);

  useEffect(() => {
    let snapshots = 0;
    return connectStream({
      onStatus: setConnected,
      onMessage: (msg) => {
        dispatch(msg);
        if (msg.type !== 'snapshot') return;
        snapshots += 1;
        if (snapshots === 1) return;
        // 다시 붙은 경우: 열어 둔 대화의 끊긴 동안 빠진 줄을 채운다.
        const alive = new Set(msg.sessions.map((s) => s.id));
        for (const id of Object.keys(ref.current.logs)) if (alive.has(id)) void loadLog(id);
      },
    });
  }, [loadLog]);

  const markSeen = useCallback((sessionId: string) => {
    dispatch({ type: 'seen', sessionId });
    api.markSeen(sessionId).catch(() => { /* 다음 스냅샷에서 바로잡힌다 */ });
  }, []);

  return { ...state, connected, markSeen, loadLog };
}
