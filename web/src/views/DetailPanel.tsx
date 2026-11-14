// 오른쪽 상세 패널(1024px 미만에서는 전체 화면). 목업 Main의 aside.panel 구조 그대로.
// 원격 답장(입력창·승인 버튼·원격 제어 링크)은 이번 범위가 아니어서 넣지 않았다.
import type { LogLine, MachineView, SessionView } from '@c-monitor/shared';
import { useLayoutEffect, useRef } from 'react';
import {
  AlertIcon, BackIcon, CheckCircleIcon, ClockIcon, CloseIcon, LockIcon, PanelIcon, PowerIcon, TerminalIcon,
} from '../components/Icons';
import { formatClock, formatDuration, formatTime } from '../lib/format';
import { firstLine, statusLabel, TAG_COLOR, toolSummary } from '../lib/view';

export type Tab = 'chat' | 'tool';

type Props = {
  session: SessionView | null;
  machine: MachineView | null;
  lines: LogLine[] | undefined;
  tab: Tab;
  onTab: (t: Tab) => void;
  onClose: () => void;
  connected: boolean;
  now: number;
};

function Marks({ line, code }: { line: LogLine; code?: string }) {
  const masked = line.masked ?? 0;
  if (!masked && !line.truncated && !code) return null;
  return (
    <div className="mask">
      {code && <code>{code}</code>}
      {masked > 0 && <span className="tag neutral"><LockIcon size={12} />키 {masked}개 가려짐</span>}
      {line.truncated && <span className="tag neutral">일부 생략</span>}
    </div>
  );
}

function Line({ line }: { line: LogLine }) {
  const t = formatTime(line.at);
  switch (line.role) {
    case 'user':
    case 'assistant':
      return (
        <div className={line.role === 'user' ? 'm m-user' : 'm m-asst'}>
          <div className="m-who"><span className="who">{line.role === 'user' ? '사용자' : 'Claude'}</span><span>{t}</span></div>
          <div className="m-body">{line.text}</div>
          <Marks line={line} />
        </div>
      );
    case 'tool': {
      const arg = toolSummary(line.toolInput, line.text);
      // 입력이 따로 있으면 본문(결과)의 첫 줄을 아래에 덧붙인다.
      const out = line.toolInput != null && line.text ? firstLine(line.text, 160) : undefined;
      return (
        <div>
          <div className="tool">
            <span className="tool-name">{line.toolName || '도구'}</span>
            <span className="tool-arg" title={arg}>{arg}</span>
            <span className="tool-at">{t}</span>
          </div>
          <Marks line={line} code={out} />
        </div>
      );
    }
    case 'system':
      return (
        <div className="m m-sys">
          <div className="m-who"><span className="who">시스템</span><span>{t}</span></div>
          <div className="m-body">{line.text}</div>
          <Marks line={line} />
        </div>
      );
  }
}

/** 대화 맨 아래 상태 상자. */
function StatusBox({ s, now }: { s: SessionView; now: number }) {
  switch (s.status) {
    case 'wait':
      return (
        <div className="ask">
          <div className="ask-title"><AlertIcon size={16} />{s.activity?.label || '답변을 기다립니다'}</div>
          {s.activity?.text && <div className="code">{s.activity.text}</div>}
          <div className="ask-note"><TerminalIcon size={14} />해당 컴퓨터의 터미널에서 답해 주세요.</div>
        </div>
      );
    case 'limit':
      return (
        <div className="ask">
          <div className="ask-title"><AlertIcon size={16} />사용 한도에 도달했습니다</div>
          {s.activity?.text && <div className="code">{s.activity.text}</div>}
          <div className="ask-note"><TerminalIcon size={14} />한도가 초기화되면 해당 컴퓨터의 터미널에서 이어 가 주세요.</div>
        </div>
      );
    case 'done':
      return (
        <div className="box ok">
          <CheckCircleIcon size={16} />
          <div><div className="box-title">작업이 끝났습니다</div><div className="box-text">다음 작업을 시작하면 초록 표시가 꺼집니다.</div></div>
        </div>
      );
    case 'lost':
      return (
        <div className="box warn">
          <ClockIcon size={16} />
          <div>
            <div className="box-title">{formatDuration(Math.max(0, now - Date.parse(s.lastEventAt)))}째 소식이 없습니다</div>
            <div className="box-text">컴퓨터가 꺼졌거나 네트워크가 끊겼을 수 있습니다. 마지막 신호 {formatTime(s.lastEventAt)}.</div>
          </div>
        </div>
      );
    case 'end':
      return (
        <div className="box neutral">
          <PowerIcon size={16} />
          <div><div className="box-title">세션이 종료되었습니다</div><div className="box-text">{formatClock(s.endedAt ?? s.lastEventAt, now)}</div></div>
        </div>
      );
    default:
      return null;
  }
}

export function DetailPanel({ session: s, machine, lines, tab, onTab, onClose, connected, now }: Props) {
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const count = lines?.length ?? 0;

  // 세션을 바꾸면 맨 아래부터 보여 준다.
  useLayoutEffect(() => { stick.current = true; }, [s?.id, tab]);
  // 맨 아래를 보고 있었으면 새 줄이 와도 따라 내려간다.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [count, s?.id, tab, s?.status]);

  if (!s) {
    return (
      <aside className="panel" aria-label="세션 상세">
        <div className="p-empty">
          <PanelIcon size={32} />
          <p>카드를 누르면 그 세션의 대화가 여기에 실시간으로 표시됩니다.</p>
        </div>
      </aside>
    );
  }

  const all = lines ?? [];
  const msgCount = all.filter((l) => l.role === 'user' || l.role === 'assistant').length;
  const tools = all.filter((l) => l.role === 'tool');
  const shown = tab === 'tool' ? tools : all;
  const label = statusLabel(s.status);
  const kv: [string, string][] = [
    ['클로드 계정', s.account ?? '—'],
    ['컴퓨터', machine?.name ?? '—'],
    ['폴더', s.cwd],
    ['브랜치', s.branch ?? '—'],
    ['모델', s.model ?? '—'],
    ['시작', formatClock(s.startedAt, now)],
  ];
  const quiet = s.status === 'end' || s.status === 'lost';
  const foot = s.status === 'end'
    ? '종료된 세션입니다 · 기록만 볼 수 있습니다'
    : s.status === 'lost'
      ? '신호를 기다리는 중입니다'
      : connected ? '실시간으로 받는 중' : '다시 연결하는 중입니다';

  return (
    <aside className="panel" aria-label="세션 상세">
      <div className="p-head">
        <div className="p-top">
          <button type="button" className="icon-btn back" aria-label="목록으로" onClick={onClose}><BackIcon /></button>
          <span className="p-name" title={s.name}>{s.name}</span>
          <span className={`tag ${TAG_COLOR[s.status]}`}><span className="dot" />{label}</span>
          <button type="button" className="icon-btn close" aria-label="닫기" onClick={onClose}><CloseIcon size={16} /></button>
        </div>
        <div className="p-grid">
          {kv.map(([k, v]) => (
            <div className="kv" key={k}><span className="k">{k}</span><span className="v" title={v}>{v}</span></div>
          ))}
        </div>
      </div>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'on' : ''} onClick={() => onTab('chat')}>
          대화 <span className="cnt">{msgCount}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'tool'} className={tab === 'tool' ? 'on' : ''} onClick={() => onTab('tool')}>
          도구 <span className="cnt">{tools.length}</span>
        </button>
      </div>
      <div
        className="log"
        ref={logRef}
        role="log"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {lines === undefined && <p className="log-empty">대화를 불러오는 중입니다.</p>}
        {lines !== undefined && shown.length === 0 && (
          <p className="log-empty">{tab === 'tool' ? '아직 도구 사용 기록이 없습니다.' : '아직 대화가 없습니다.'}</p>
        )}
        {shown.map((l) => <Line key={l.seq} line={l} />)}
        {tab === 'chat' && <StatusBox s={s} now={now} />}
      </div>
      <div className="p-foot"><span className={quiet || !connected ? 'live-dot off' : 'live-dot'} />{foot}</div>
    </aside>
  );
}
