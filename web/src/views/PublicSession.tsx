// 공유 링크로 보는 세션(/s/<토큰>). 로그인 없이 보기만: 상태·대화(100줄씩, 이전 더 보기)와 실시간 갱신.
// 컴퓨터·계정·폴더·다른 세션·답장·원격 제어는 서버가 내려 주지 않고, 화면도 그리지 않는다.
import type { PublicSessionView, PublicStreamMessage, SessionView } from '@c-monitor/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api/client';
import { connectStream } from '../api/stream';
import { EyeIcon, MoonIcon, PulseIcon, SunIcon } from '../components/Icons';
import { formatClock } from '../lib/format';
import { useNow, useTheme } from '../lib/prefs';
import { applyPage, mergeLines, type LogWindow } from '../state/store';
import { DetailPanel, type Tab } from './DetailPanel';

const PUBLIC_TYPES: ReadonlySet<string> = new Set(['public', 'log']);

/** 공개 보기를 상세 패널이 그릴 수 있는 모양으로. 비어 있는 칸은 화면에 쓰지 않는다. */
export function toPanelSession(token: string, p: PublicSessionView): SessionView {
  return {
    id: `public:${token}`, machineId: '', account: null, cwd: '', name: p.name, branch: p.branch, model: p.model,
    status: p.status, seen: true, startedAt: p.startedAt, lastEventAt: p.lastEventAt, endedAt: p.endedAt,
    activity: p.activity, pending: null, canReply: false, queuedMessages: 0, remoteUrl: null,
    contextPct: p.contextPct, costUsd: p.costUsd, telegram: false,
  };
}

type State = { kind: 'loading' } | { kind: 'gone' } | { kind: 'error' } | { kind: 'ok'; session: PublicSessionView };

export function PublicSession({ token }: { token: string }) {
  const theme = useTheme();
  const now = useNow();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [log, setLog] = useState<LogWindow | undefined>(undefined);
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState<Tab>('chat');
  const [attempt, setAttempt] = useState(0);
  const logRef = useRef(log);
  logRef.current = log;

  const load = useCallback(async () => {
    try {
      const [s, page] = await Promise.all([api.getPublicSession(token), api.getPublicLog(token)]);
      setState({ kind: 'ok', session: s });
      setLog((prev) => applyPage(prev, 'latest', page));
    } catch (e) {
      setState(e instanceof api.ApiError && e.status === 404 ? { kind: 'gone' } : { kind: 'error' });
    }
  }, [token]);

  useEffect(() => { void load(); }, [load, attempt]);

  // 실시간: 상태(public)와 새 줄(log)만 받는다.
  const ok = state.kind === 'ok';
  useEffect(() => {
    if (!ok) return;
    return connectStream<PublicStreamMessage>({
      onStatus: setConnected,
      onMessage: (msg) => {
        if (msg.type === 'public') setState({ kind: 'ok', session: msg.session });
        else if (msg.type === 'log' && Array.isArray(msg.lines)) {
          setLog((win) => (win && !win.hasMoreAfter
            ? { ...win, lines: mergeLines(win.lines, msg.lines), total: win.total == null ? null : win.total + msg.lines.filter((l) => l.seq > (win.lines[win.lines.length - 1]?.seq ?? -1)).length }
            : win));
        }
      },
    }, { url: api.publicStreamUrl(token), types: PUBLIC_TYPES });
  }, [ok, token]);

  const loadOlder = useCallback(async () => {
    const win = logRef.current;
    if (!win?.hasMoreBefore || !win.lines.length) return;
    try {
      const page = await api.getPublicLog(token, { before: win.lines[0]!.seq });
      setLog((prev) => applyPage(prev, 'before', page));
    } catch { /* 버튼이 그대로 남아 다시 누를 수 있다 */ }
  }, [token]);

  const latest = useCallback(async () => {
    try { setLog(applyPage(undefined, 'latest', await api.getPublicLog(token))); } catch { /* 그대로 둔다 */ }
  }, [token]);

  const head = (
    <header className="hdr">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true"><PulseIcon /></span>
        <span className="brand-name">C-Monitor</span>
        <span className="tag neutral"><EyeIcon size={12} />공유된 세션 · 보기만</span>
      </div>
      <div className="hdr-actions">
        <button type="button" className="icon-btn" aria-label="테마 바꾸기" onClick={theme.toggle}>
          {theme.dark ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>
    </header>
  );

  if (state.kind !== 'ok') {
    const [title, text] = state.kind === 'gone'
      ? ['볼 수 없는 링크입니다', '링크가 만료되었거나 공유가 취소되었습니다. 공유한 사람에게 새 링크를 받아 주세요.']
      : state.kind === 'error'
        ? ['불러오지 못했습니다', '잠시 뒤 다시 시도해 주세요.']
        : ['불러오는 중입니다', ''];
    return (
      <div className={`app ${theme.cls}`}>
        {head}
        <div className="center public-center">
          <div className="auth" role="status">
            <div className="auth-head">
              <h1 className="h1" style={{ fontSize: 20 }}>{title}</h1>
              {text && <p className="sub" style={{ margin: 0 }}>{text}</p>}
            </div>
            {state.kind === 'error' && <button type="button" className="btn primary block" onClick={() => setAttempt((n) => n + 1)}>다시 시도</button>}
          </div>
        </div>
      </div>
    );
  }

  const p = state.session;
  const expired = !!p.expiresAt && Date.parse(p.expiresAt) <= now;
  return (
    <div className={`app public-page open ${theme.cls}`}>
      {head}
      <div className="public-wrap">
        <p className="hint public-note">
          보기 전용 링크입니다 · {p.expiresAt ? `${formatClock(p.expiresAt, now)}까지 볼 수 있습니다` : '만료 없음'}
          {expired && ' · 만료되었습니다'}
        </p>
        <DetailPanel
          session={toPanelSession(token, p)}
          machine={null}
          log={log}
          tab={tab}
          onTab={setTab}
          connected={connected}
          now={now}
          onLoadOlder={loadOlder}
          onLatest={latest}
          readOnly
          notice="보기 전용 링크입니다. 답하거나 바꿀 수 없습니다."
          publicInfo={{ expiresAt: p.expiresAt }}
        />
      </div>
    </div>
  );
}
