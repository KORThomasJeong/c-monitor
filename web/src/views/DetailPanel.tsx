// 오른쪽 상세 패널(1024px 미만에서는 전체 화면). 목업 Main의 aside.panel 구조 그대로.
// 대화는 100줄씩 불러온다: 처음엔 최근 100줄, "이전 대화 더 보기"로 앞을 더 붙이고,
// 검색 결과로 옮기면 그 줄을 가운데로 범위를 바꿔 불러온다.
// 원격 답장(입력창·승인 버튼·원격 제어 링크)은 이번 범위가 아니어서 넣지 않았다.
import {
  SEARCH_MIN_CHARS,
  type LogLine,
  type LogSearchResponse,
  type MachineView,
  type SessionView,
} from '@c-monitor/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  AlertIcon, ArrowDownIcon, BackIcon, CheckCircleIcon, ChevronDownIcon, ChevronUpIcon, ClockIcon, CloseIcon, LockIcon,
  PanelIcon, PowerIcon, SearchIcon, TerminalIcon, TrashIcon,
} from '../components/Icons';
import { formatClock, formatDuration, formatTime } from '../lib/format';
import { canDelete, splitMatches, statusLabel, TAG_COLOR, toolText } from '../lib/view';
import type { LogWindow } from '../state/store';

export type Tab = 'chat' | 'tool';

type Props = {
  session: SessionView | null;
  machine: MachineView | null;
  log: LogWindow | undefined;
  tab: Tab;
  onTab: (t: Tab) => void;
  onClose: () => void;
  connected: boolean;
  now: number;
  onLoadOlder?: () => Promise<void>;
  onJump?: (seq: number) => Promise<void>;
  onLatest?: () => Promise<void>;
  onSearch?: (q: string) => Promise<LogSearchResponse>;
  onDelete?: () => void;
};

/** 찾은 글자를 <mark>로 감싼다. */
function Hl({ text, q }: { text: string; q: string }) {
  const parts = splitMatches(text, q);
  if (parts.length === 1 && !parts[0]!.hit) return <>{text}</>;
  return <>{parts.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</>;
}

function Marks({ line }: { line: LogLine }) {
  const masked = line.masked ?? 0;
  if (!masked && !line.truncated) return null;
  return (
    <div className="mask">
      {masked > 0 && <span className="tag neutral"><LockIcon size={12} />키 {masked}개 가려짐</span>}
      {line.truncated && <span className="tag neutral">일부 생략</span>}
    </div>
  );
}

function ToolLine({ line, q, hit }: { line: LogLine; q: string; hit: boolean }) {
  const { head, rest } = toolText(line);
  const [open, setOpen] = useState(false);
  // 검색으로 옮겨 온 줄인데 찾은 글자가 접힌 부분에 있으면 펼쳐 둔다.
  useEffect(() => {
    if (hit && rest && splitMatches(rest, q).some((p) => p.hit) && !splitMatches(head, q).some((p) => p.hit)) setOpen(true);
  }, [hit, rest, head, q]);
  return (
    <>
      <div className="tool">
        <span className="tool-name">{line.toolName || '도구'}</span>
        <span className="tool-arg" title={head}><Hl text={head} q={q} /></span>
        {rest && (
          <button type="button" className="tool-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? '접기' : '펼치기'}
          </button>
        )}
        <span className="tool-at">{formatTime(line.at)}</span>
      </div>
      {open && rest && <pre className="tool-out"><Hl text={rest} q={q} /></pre>}
      <Marks line={line} />
    </>
  );
}

const WHO: Record<LogLine['role'], string> = { user: '사용자', assistant: 'Claude', tool: '도구', system: '시스템' };

function Line({ line, q, hit }: { line: LogLine; q: string; hit: boolean }) {
  const cls = hit ? 'ln hit' : 'ln';
  if (line.role === 'tool') {
    return <div className={cls} data-seq={line.seq}><ToolLine line={line} q={q} hit={hit} /></div>;
  }
  const kind = line.role === 'user' ? 'm m-user' : line.role === 'assistant' ? 'm m-asst' : 'm m-sys';
  return (
    <div className={`${cls} ${kind}`} data-seq={line.seq}>
      <div className="m-who"><span className="who">{WHO[line.role]}</span><span>{formatTime(line.at)}</span></div>
      <div className="m-body"><Hl text={line.text} q={q} /></div>
      <Marks line={line} />
    </div>
  );
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

/** 대화가 패널 안에서 스크롤되면 그 상자, 아니면(휴대폰 가로 등) 문서 전체. */
function scrollBox(el: HTMLElement): HTMLElement {
  if (el.scrollHeight > el.clientHeight + 1) return el;
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}
const nearBottom = (box: HTMLElement) => box.scrollHeight - box.scrollTop - box.clientHeight < 48;

type Search = {
  /** 결과를 받은 검색어(강조에 쓴다) */
  q: string;
  res: LogSearchResponse;
};

export function DetailPanel(props: Props) {
  const { session: s, machine, log, tab, onTab, onClose, connected, now } = props;
  const { onLoadOlder, onJump, onLatest, onSearch, onDelete } = props;
  const logRef = useRef<HTMLDivElement>(null);
  /** 맨 아래 근처를 보고 있다(새 줄이 오면 따라 내려간다). */
  const stick = useRef(true);
  /** "이전 대화 더 보기" 직전의 높이·위치. 앞에 줄이 붙어도 보던 곳이 튀지 않게 맞춘다. */
  const anchor = useRef<{ height: number; top: number; box: HTMLElement } | null>(null);
  const [older, setOlder] = useState(false);

  // 검색
  const [text, setText] = useState('');
  const [found, setFound] = useState<Search | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [focus, setFocus] = useState<{ seq: number; tick: number } | null>(null);
  const asked = useRef('');
  /** 이미 스크롤해 준 이동(tick). 실시간 줄이 붙을 때마다 다시 가운데로 끌어오지 않게 한다. */
  const focusDone = useRef(0);
  const reqId = useRef(0);

  const lines = log?.lines;
  const first = lines?.[0]?.seq;
  const last = lines?.length ? lines[lines.length - 1]!.seq : undefined;

  // 세션·탭을 바꾸면 맨 아래부터 보여 준다.
  useLayoutEffect(() => { stick.current = true; }, [s?.id, tab]);

  // 줄이 바뀐 뒤 스크롤 위치를 맞춘다.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (anchor.current) {
      const a = anchor.current;
      anchor.current = null;
      a.box.scrollTop = a.top + (el.scrollHeight - a.height);
      return;
    }
    if (focus && focusDone.current !== focus.tick) {
      const target = el.querySelector<HTMLElement>(`[data-seq="${focus.seq}"]`);
      if (target) { focusDone.current = focus.tick; target.scrollIntoView?.({ block: 'center' }); }
      return;
    }
    if (stick.current && !log?.hasMoreAfter) {
      const box = scrollBox(el);
      box.scrollTop = box.scrollHeight;
    }
  }, [first, last, lines?.length, s?.id, tab, s?.status, focus, log?.hasMoreAfter]);

  // 문서 전체가 스크롤되는 화면에서도 맨 아래 근처인지 따라간다.
  useEffect(() => {
    const on = () => { const el = logRef.current; if (el && scrollBox(el) !== el) stick.current = nearBottom(scrollBox(el)); };
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);

  const clearSearch = useCallback(() => {
    reqId.current += 1;
    asked.current = '';
    setText('');
    setFound(null);
    setSearching(false);
    setSearchFailed(false);
    setActive(null);
    setFocus(null);
  }, []);

  const runSearch = useCallback(async (raw: string) => {
    const q = raw.trim();
    if (Array.from(q).length < SEARCH_MIN_CHARS || !onSearch) {
      reqId.current += 1;
      asked.current = '';
      setFound(null);
      setSearching(false);
      setSearchFailed(false);
      setActive(null);
      setFocus(null);
      return false;
    }
    if (q === asked.current) return true;
    asked.current = q;
    const id = ++reqId.current;
    setSearching(true);
    setSearchFailed(false);
    try {
      const res = await onSearch(q);
      if (id !== reqId.current) return true;
      setFound({ q, res: { hits: res?.hits ?? [], total: res?.total ?? 0 } });
      setActive(null);
      setFocus(null);
    } catch {
      if (id !== reqId.current) return true;
      asked.current = '';
      setFound(null);
      setSearchFailed(true);
    } finally {
      if (id === reqId.current) setSearching(false);
    }
    return true;
  }, [onSearch]);

  // 입력을 멈추고 300ms 뒤 찾는다.
  useEffect(() => {
    const t = setTimeout(() => { void runSearch(text); }, 300);
    return () => clearTimeout(t);
  }, [text, runSearch]);

  const goTo = async (i: number) => {
    const hit = found?.res.hits[i];
    if (!hit) return;
    setActive(i);
    stick.current = false;
    if (tab === 'tool' && hit.role !== 'tool') onTab('chat');
    setFocus((f) => ({ seq: hit.seq, tick: (f?.tick ?? 0) + 1 }));
    await onJump?.(hit.seq);
  };
  const hitCount = found?.res.hits.length ?? 0;
  /** 이전 결과 = 더 오래된 쪽(목록 아래). 결과는 최신부터 온다. */
  const goOlder = () => void goTo(active == null ? 0 : Math.min(hitCount - 1, active + 1));
  const goNewer = () => void goTo(active == null ? 0 : Math.max(0, active - 1));

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); clearSearch(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const q = text.trim();
    // 같은 검색어로 이미 결과가 있으면 Enter는 다음(더 오래된) 결과로 옮긴다.
    if (found && found.q === q && hitCount > 0) goOlder();
    else void runSearch(text);
  };

  const loadOlder = async () => {
    const el = logRef.current;
    if (!onLoadOlder || older) return;
    if (el) { const box = scrollBox(el); anchor.current = { height: el.scrollHeight, top: box.scrollTop, box }; }
    setOlder(true);
    try { await onLoadOlder(); } finally { setOlder(false); }
    // 앞에 붙은 줄이 없었으면(실패 등) 기준점을 버린다. 붙었으면 그 전에 이미 쓰였다.
    setTimeout(() => { anchor.current = null; }, 0);
  };

  const toLatest = async () => {
    stick.current = true;
    setFocus(null);
    setActive(null);
    await onLatest?.();
  };

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
  const complete = !!log && !log.loading && !log.hasMoreBefore && !log.hasMoreAfter;
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
  const q = found?.q ?? '';
  const loading = !log || (log.loading && all.length === 0);
  const partial = !!log && !log.loading && (log.hasMoreBefore || log.hasMoreAfter);
  const tabTitle = complete ? undefined : '불러온 대화만 셉니다';

  return (
    <aside className="panel" aria-label="세션 상세">
      <div className="p-head">
        <div className="p-top">
          <button type="button" className="icon-btn back" aria-label="목록으로" onClick={onClose}><BackIcon /></button>
          <span className="p-name" title={s.name}>{s.name}</span>
          <span className={`tag ${TAG_COLOR[s.status]}`}><span className="dot" />{label}</span>
          {onDelete && canDelete(s.status) && (
            <button type="button" className="icon-btn p-del" aria-label="세션 지우기" title="세션과 대화 기록을 지웁니다" onClick={onDelete}>
              <TrashIcon size={16} />
            </button>
          )}
          <button type="button" className="icon-btn close" aria-label="닫기" onClick={onClose}><CloseIcon size={16} /></button>
        </div>
        <div className="p-grid">
          {kv.map(([k, v]) => (
            <div className="kv" key={k}><span className="k">{k}</span><span className="v" title={v}>{v}</span></div>
          ))}
        </div>
      </div>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'on' : ''} onClick={() => onTab('chat')} title={tabTitle}>
          대화{complete && <> <span className="cnt">{msgCount}</span></>}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'tool'} className={tab === 'tool' ? 'on' : ''} onClick={() => onTab('tool')} title={tabTitle}>
          도구{complete && <> <span className="cnt">{tools.length}</span></>}
        </button>
      </div>

      {onSearch && (
        <div className="p-search" role="search">
          <div className="s-row">
            <label className="s-field">
              <SearchIcon size={16} />
              <input
                type="search"
                className="s-input"
                aria-label="대화 검색"
                placeholder="대화에서 찾기"
                value={text}
                maxLength={200}
                enterKeyHint="search"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKey}
              />
              {text && (
                <button type="button" className="s-clear" aria-label="검색 지우기" onClick={clearSearch}><CloseIcon size={16} /></button>
              )}
            </label>
            {found && found.res.total > 0 && (
              <div className="s-nav">
                <span className="s-count">{found.res.total}건</span>
                <button type="button" className="icon-btn s-step" aria-label="이전 결과" title="더 오래된 결과"
                  onClick={goOlder} disabled={active === hitCount - 1}>
                  <ChevronUpIcon size={16} />
                </button>
                <button type="button" className="icon-btn s-step" aria-label="다음 결과" title="더 최근 결과"
                  onClick={goNewer} disabled={active == null || active === 0}>
                  <ChevronDownIcon size={16} />
                </button>
              </div>
            )}
          </div>
          <div className="s-status" role="status">
            {searching && '찾는 중입니다'}
            {!searching && searchFailed && '검색하지 못했습니다. 잠시 뒤 다시 시도해 주세요.'}
            {!searching && found && found.res.total === 0 && '찾은 대화가 없습니다'}
            {!searching && found && found.res.total > hitCount && '최근 50건만 표시'}
          </div>
          {found && hitCount > 0 && (
            <ol className="hits" aria-label="검색 결과">
              {found.res.hits.map((h, i) => (
                <li key={`${h.seq}-${i}`}>
                  <button type="button" className={i === active ? 'hit-item on' : 'hit-item'} aria-current={i === active ? 'true' : undefined} onClick={() => void goTo(i)}>
                    <span className="hit-meta">{formatTime(h.at)} · {h.role === 'tool' ? h.toolName || '도구' : WHO[h.role]}</span>
                    <span className="hit-text"><Hl text={h.snippet} q={found.q} /></span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      <div
        className="log"
        ref={logRef}
        role="log"
        aria-live="polite"
        onScroll={(e) => { stick.current = nearBottom(e.currentTarget); }}
      >
        {(partial || log?.hasMoreBefore) && (
          <div className="log-range">
            {partial && log?.total != null && <span>전체 {log.total}줄 중 {all.length}줄</span>}
            {log?.hasMoreBefore && onLoadOlder && (
              <button type="button" className="btn sm" onClick={loadOlder} disabled={older}>
                {older ? '불러오는 중' : '이전 대화 더 보기'}
              </button>
            )}
          </div>
        )}
        {loading && <p className="log-empty">대화를 불러오는 중입니다.</p>}
        {!loading && shown.length === 0 && (
          <p className="log-empty">
            {tab === 'tool' ? (partial ? '불러온 대화에는 도구 사용 기록이 없습니다.' : '아직 도구 사용 기록이 없습니다.') : '아직 대화가 없습니다.'}
          </p>
        )}
        {shown.map((l) => <Line key={l.seq} line={l} q={q} hit={focus?.seq === l.seq} />)}
        {tab === 'chat' && !log?.hasMoreAfter && <StatusBox s={s} now={now} />}
        {log?.hasMoreAfter && (
          <div className="to-latest">
            <button type="button" className="btn sm primary" onClick={toLatest}>
              <ArrowDownIcon size={16} />
              {log.fresh > 0 ? `새 대화 ${log.fresh}줄 · 최신으로` : '최신으로'}
            </button>
          </div>
        )}
      </div>
      <div className="p-foot"><span className={quiet || !connected ? 'live-dot off' : 'live-dot'} />{foot}</div>
    </aside>
  );
}

