// 대시보드 상태. 스트림 메시지와 화면 동작을 순수 함수 reduce로 합친다.
import type {
  AccountView,
  LogLine,
  LogResponse,
  MachineView,
  SessionView,
  StreamMessage,
} from '@c-monitor/shared';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import * as api from '../api/client';
import { connectStream } from '../api/stream';

/** 상세 패널에 불러 둔 대화 한 토막. 세션 전체가 아니라 100줄씩 불러온 범위다. */
export type LogWindow = {
  /** seq 오름차순, 중복 없음 */
  lines: LogLine[];
  /** 서버에 저장된 전체 줄 수(모르면 null) */
  total: number | null;
  /** 불러온 범위 앞에 줄이 더 있다 */
  hasMoreBefore: boolean;
  /** 불러온 범위 뒤에 줄이 더 있다 = 최신에 붙어 있지 않다(검색으로 과거를 보는 중) */
  hasMoreAfter: boolean;
  /** 최신에 붙어 있지 않은 동안 새로 들어온 줄 수 */
  fresh: number;
  /** 처음 불러오는 중 */
  loading: boolean;
};

export type DashboardState = {
  sessions: SessionView[];
  machines: MachineView[];
  accounts: AccountView[];
  /** 세션별로 불러 둔 대화. 상세를 연 세션만 있다. */
  logs: Record<string, LogWindow>;
  /** 첫 snapshot을 받았는지 */
  loaded: boolean;
};

export const emptyState: DashboardState = { sessions: [], machines: [], accounts: [], logs: {}, loaded: false };

const emptyWindow: LogWindow = { lines: [], total: null, hasMoreBefore: false, hasMoreAfter: false, fresh: 0, loading: false };

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
      // 통째로 바꾼다. 대화는 스냅샷에 없으니 아직 있는 세션 것만 남긴다(빠진 줄은 다시 불러 채움).
      const alive = new Set(msg.sessions.map((s) => s.id));
      const logs: Record<string, LogWindow> = {};
      for (const [id, win] of Object.entries(state.logs)) if (alive.has(id)) logs[id] = win;
      return { sessions: msg.sessions, machines: msg.machines, accounts: msg.accounts, logs, loaded: true };
    }
    case 'session':
      return { ...state, sessions: upsert(state.sessions, msg.session, (s) => s.id === msg.session.id) };
    case 'machine':
      return { ...state, machines: upsert(state.machines, msg.machine, (m) => m.id === msg.machine.id) };
    case 'limits':
      return { ...state, accounts: upsert(state.accounts, msg.account, (a) => a.email === msg.account.email) };
    case 'log': {
      const win = state.logs[msg.sessionId];
      // 열어 보지 않은 세션은 담지 않는다(열 때 최근 줄을 새로 불러온다).
      if (!win) return state;
      const last = win.lines.length ? win.lines[win.lines.length - 1]!.seq : -1;
      const added = msg.lines.filter((l) => l.seq > last).length;
      const total = win.total == null ? null : win.total + added;
      const next: LogWindow = win.hasMoreAfter
        // 과거를 보는 중: 붙이지 않고 새 줄 수만 센다.
        ? { ...win, total, fresh: win.fresh + added }
        : { ...win, total, lines: mergeLines(win.lines, msg.lines) };
      return { ...state, logs: { ...state.logs, [msg.sessionId]: next } };
    }
    case 'removed': {
      const gone = new Set(msg.sessionIds);
      const logs = { ...state.logs };
      for (const id of msg.sessionIds) delete logs[id];
      return { ...state, sessions: state.sessions.filter((s) => !gone.has(s.id)), logs };
    }
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

export type PageKind = 'latest' | 'around' | 'before' | 'after';

export type Action =
  | StreamMessage
  | { type: 'seen'; sessionId: string }
  /** 처음 불러오기 시작. 그동안 온 실시간 줄을 받아 둘 창을 만든다. */
  | { type: 'logLoading'; sessionId: string }
  | { type: 'logPage'; sessionId: string; kind: PageKind; res: LogResponse }
  | { type: 'logFailed'; sessionId: string }
  /** 지우기에 실패해 되돌린다. index는 원래 자리. */
  | { type: 'restore'; session: SessionView; log?: LogWindow; index: number };

/** 서버가 준 한 쪽을 창에 합친다. */
export function applyPage(prev: LogWindow | undefined, kind: PageKind, res: LogResponse): LogWindow {
  const lines = res?.lines ?? [];
  const total = typeof res?.total === 'number' ? res.total : null;
  if (kind === 'before' && prev) {
    return {
      ...prev,
      lines: mergeLines(lines, prev.lines),
      hasMoreBefore: !!res.hasMoreBefore,
      total: total == null ? prev.total : Math.max(total, prev.total ?? 0),
      loading: false,
    };
  }
  if (kind === 'after' && prev) {
    return { ...prev, lines: mergeLines(prev.lines, lines), hasMoreAfter: !!res.hasMoreAfter, total, loading: false };
  }
  // latest·around: 범위를 통째로 바꾼다.
  let merged = lines;
  let extra = 0;
  if (kind === 'latest' && !res?.hasMoreAfter && prev && !prev.hasMoreAfter) {
    // 불러오는 동안 실시간으로 온 줄은 응답 뒤에 이어 붙인다.
    const last = lines.length ? lines[lines.length - 1]!.seq : -1;
    const later = prev.lines.filter((l) => l.seq > last);
    if (later.length) { merged = mergeLines(lines, later); extra = later.length; }
  }
  return {
    lines: merged,
    total: total == null ? null : total + extra,
    hasMoreBefore: !!res?.hasMoreBefore,
    hasMoreAfter: !!res?.hasMoreAfter,
    fresh: 0,
    loading: false,
  };
}

export function reduce(s: DashboardState, a: Action): DashboardState {
  switch (a.type) {
    case 'seen':
      return markSeenLocal(s, a.sessionId);
    case 'logLoading': {
      const prev = s.logs[a.sessionId];
      const base = prev && !prev.hasMoreAfter ? prev : emptyWindow;
      return { ...s, logs: { ...s.logs, [a.sessionId]: { ...base, loading: true } } };
    }
    case 'logPage':
      if (!s.sessions.some((x) => x.id === a.sessionId)) return s;
      return { ...s, logs: { ...s.logs, [a.sessionId]: applyPage(s.logs[a.sessionId], a.kind, a.res) } };
    case 'logFailed': {
      const prev = s.logs[a.sessionId];
      return { ...s, logs: { ...s.logs, [a.sessionId]: { ...(prev ?? emptyWindow), loading: false } } };
    }
    case 'restore': {
      if (s.sessions.some((x) => x.id === a.session.id)) return s;
      const sessions = s.sessions.slice();
      sessions.splice(Math.min(Math.max(a.index, 0), sessions.length), 0, a.session);
      const logs = a.log && !s.logs[a.session.id] ? { ...s.logs, [a.session.id]: a.log } : s.logs;
      return { ...s, sessions, logs };
    }
    default:
      return applyMessage(s, a);
  }
}

export type Dashboard = DashboardState & {
  connected: boolean;
  /** 화면에서 바로 seen 처리하고 서버에 알린다. */
  markSeen: (sessionId: string) => void;
  /** 가장 최근 100줄을 새로 불러온다(카드를 열 때, "최신으로"). */
  openLog: (sessionId: string) => Promise<void>;
  /** 불러온 범위 앞의 100줄을 더 불러온다. */
  loadOlder: (sessionId: string) => Promise<void>;
  /** 그 줄이 불러온 범위에 없으면 그 줄을 가운데로 범위를 바꿔 불러온다. */
  jumpTo: (sessionId: string, seq: number) => Promise<void>;
  /** 화면에서 바로 없애고 서버에 지우기를 요청한다. 실패하면 되돌리고 false. */
  removeSession: (sessionId: string) => Promise<boolean>;
};

export function useDashboard(): Dashboard {
  const [state, dispatch] = useReducer(reduce, emptyState);
  const [connected, setConnected] = useState(false);
  const ref = useRef(state);
  ref.current = state;
  // 세션마다 범위를 통째로 바꾼 횟수. 늦게 온 앞·뒤 덧붙이기 응답이 새 범위를 망치지 않게 한다.
  const gen = useRef<Record<string, number>>({});
  const older = useRef<Set<string>>(new Set());

  const replace = useCallback(async (sessionId: string, kind: 'latest' | 'around', seq?: number) => {
    const g = (gen.current[sessionId] = (gen.current[sessionId] ?? 0) + 1);
    if (kind === 'latest') dispatch({ type: 'logLoading', sessionId });
    try {
      const res = kind === 'around' ? await api.getLog(sessionId, { around: seq! }) : await api.getLog(sessionId);
      if (gen.current[sessionId] === g) dispatch({ type: 'logPage', sessionId, kind, res });
    } catch {
      // "불러오는 중"에 머물지 않게 빈 창으로 둔다. 이후 줄은 스트림으로 이어 붙는다.
      if (gen.current[sessionId] === g) dispatch({ type: 'logFailed', sessionId });
    }
  }, []);

  const openLog = useCallback((sessionId: string) => replace(sessionId, 'latest'), [replace]);

  const loadOlder = useCallback(async (sessionId: string) => {
    const win = ref.current.logs[sessionId];
    if (!win || !win.hasMoreBefore || !win.lines.length || older.current.has(sessionId)) return;
    const g = gen.current[sessionId];
    older.current.add(sessionId);
    try {
      const res = await api.getLog(sessionId, { before: win.lines[0]!.seq });
      if (gen.current[sessionId] === g) dispatch({ type: 'logPage', sessionId, kind: 'before', res });
    } catch {
      /* 버튼이 그대로 남아 다시 누를 수 있다 */
    } finally {
      older.current.delete(sessionId);
    }
  }, []);

  const jumpTo = useCallback(async (sessionId: string, seq: number) => {
    const win = ref.current.logs[sessionId];
    if (win?.lines.some((l) => l.seq === seq)) return;
    await replace(sessionId, 'around', seq);
  }, [replace]);

  /** 다시 붙은 뒤: 최신에 붙어 있는 창만 끊긴 동안 빠진 줄을 채운다. */
  const fillMissing = useCallback(async (sessionId: string) => {
    const win = ref.current.logs[sessionId];
    if (!win || win.hasMoreAfter || win.loading) return;
    if (!win.lines.length) { await replace(sessionId, 'latest'); return; }
    const g = gen.current[sessionId];
    try {
      const res = await api.getLog(sessionId, { after: win.lines[win.lines.length - 1]!.seq });
      if (gen.current[sessionId] !== g) return;
      // 너무 많이 빠졌으면 이어 붙이지 않고 최근 줄을 새로 받는다.
      if (res?.hasMoreAfter) await replace(sessionId, 'latest');
      else dispatch({ type: 'logPage', sessionId, kind: 'after', res });
    } catch {
      /* 다음 재연결이나 다시 열 때 채운다 */
    }
  }, [replace]);

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
        for (const id of Object.keys(ref.current.logs)) if (alive.has(id)) void fillMissing(id);
      },
    });
  }, [fillMissing]);

  const markSeen = useCallback((sessionId: string) => {
    dispatch({ type: 'seen', sessionId });
    api.markSeen(sessionId).catch(() => { /* 다음 스냅샷에서 바로잡힌다 */ });
  }, []);

  const removeSession = useCallback(async (sessionId: string) => {
    const index = ref.current.sessions.findIndex((s) => s.id === sessionId);
    if (index < 0) return true;
    const session = ref.current.sessions[index]!;
    const log = ref.current.logs[sessionId];
    dispatch({ type: 'removed', sessionIds: [sessionId] });
    try {
      await api.deleteSession(sessionId);
      return true;
    } catch (e) {
      // 이미 없는 세션(404)이면 지운 것과 같다.
      if (e instanceof api.ApiError && e.status === 404) return true;
      dispatch({ type: 'restore', session, log, index });
      return false;
    }
  }, []);

  return { ...state, connected, markSeen, openLog, loadOlder, jumpTo, removeSession };
}
