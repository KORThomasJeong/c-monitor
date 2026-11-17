// 대시보드: 상세 보기(한도 카드·필터·컴퓨터별 묶음·상세 패널)와 간단히 보기(타일)를 오간다.
// 3차: "현재 / 기록" 전환, 공유받은 세션 묶음, 관리자가 남의 대시보드 보기(?user=, 읽기 전용),
// 주소 /?session=<id> 로 바로 열기, 웹 알림 소리, 공유 창, 웹·텔레그램 답 기록.
import type { MeResponse, SessionStatus, SessionView } from '@c-monitor/shared';
import * as api from '../api/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Header } from '../components/Header';
import { BackIcon, BellIcon, EyeIcon, GridIcon, ListIcon, PcIcon, ServerIcon, ShareIcon } from '../components/Icons';
import { LimitCards, LimitPills } from '../components/Limits';
import { SessionCard } from '../components/SessionCard';
import { ShareDialog } from '../components/ShareDialog';
import { formatAgo } from '../lib/format';
import { MODE_KEY, useNow, useStoredChoice, useTheme } from '../lib/prefs';
import { chimeFor, installSoundUnlock, isSoundOn, playChime } from '../lib/sound';
import { accountStyles, groupByMachine, isPcOs, isUnseen, isWaitLike, sortSessions } from '../lib/view';
import { Link, navigate, useLocation } from '../router';
import { useReplies } from '../state/reply';
import { useDashboard } from '../state/store';
import { Deck } from './Deck';
import { DetailPanel, type NotifyCtl, type Tab } from './DetailPanel';
import { HistoryList } from './History';

type Filter = 'all' | 'wait' | 'done' | 'run' | 'lost' | 'end';
const FILTERS: [Filter, string][] = [
  ['all', '전체'], ['wait', '기다림'], ['done', '끝남'], ['run', '작업 중'], ['lost', '끊김'], ['end', '종료'],
];
/** "기다림" 필터에는 한도 초과도 넣는다(같은 빨강 취급). */
const passes = (f: Filter, s: SessionStatus) => f === 'all' || (f === 'wait' ? isWaitLike(s) : s === f);

const MODES = ['detail', 'deck'] as const;
type View = 'now' | 'history';

/** 주소에서 ?session= 만 뺀다(다시 그려도 또 열지 않게). */
function dropSessionParam() {
  const p = new URLSearchParams(window.location.search);
  if (!p.has('session')) return;
  p.delete('session');
  const q = p.toString();
  navigate(`${window.location.pathname}${q ? `?${q}` : ''}`, { replace: true });
}

export function Dashboard({ me }: { me: MeResponse }) {
  const { search } = useLocation();
  const isAdmin = me.user.role === 'admin';
  const userParam = search.get('user');
  /** 관리자가 남의 대시보드를 보는 중이면 그 사용자 id. 이때는 모두 읽기 전용이다. */
  const viewUser = isAdmin && userParam && userParam !== me.user.id ? userParam : null;
  const readOnly = !!viewUser;
  const wanted = search.get('session');

  const data = useDashboard(viewUser ? { userId: viewUser } : {});
  const { machines, accounts, logs, replies, connected, loaded, markSeen, openLog, loadOlder, jumpTo, removeSession, setTelegram, loadHistory } = data;
  const reply = useReplies();
  const theme = useTheme();
  const now = useNow();
  const [mode, setMode] = useStoredChoice(MODE_KEY, MODES, 'detail');
  const [view, setView] = useState<View>('now');
  const [filter, setFilter] = useState<Filter>('all');
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('chat');
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [sharing, setSharing] = useState<string | null>(null);
  /** 텔레그램을 연결했거나 웹 알림을 켠 브라우저가 있는가(세션별 "알림" 스위치용). 못 불러오면 null = 스위치 없음. */
  const [notifyOn, setNotifyOn] = useState<boolean | null>(null);
  /** 남의 대시보드를 볼 때 그 사람 이름 */
  const [viewName, setViewName] = useState<string | null>(null);

  // 보기만일 때는 답 버튼·"눌러서 답하기"가 보이지 않게 한다(서버도 남의 세션 쓰기를 막는다).
  const sessions = useMemo<SessionView[]>(
    () => (readOnly ? data.sessions.map((s) => ({ ...s, canReply: false })) : data.sessions),
    [data.sessions, readOnly],
  );
  const history = useMemo<SessionView[] | null>(
    () => (data.history ? data.history.map((s) => ({ ...s, canReply: false })) : null),
    [data.history],
  );

  useEffect(() => {
    if (readOnly) return;
    let live = true;
    Promise.allSettled([api.getNotify(), api.getPushSubscriptions()]).then(([n, p]) => {
      if (!live) return;
      if (n.status === 'rejected' && p.status === 'rejected') { setNotifyOn(null); return; }
      const tg = n.status === 'fulfilled' && !!n.value?.telegram?.linked;
      const push = p.status === 'fulfilled' && (p.value?.length ?? 0) > 0;
      setNotifyOn(tg || push);
    });
    return () => { live = false; };
  }, [readOnly]);

  useEffect(() => {
    if (!viewUser) return;
    let live = true;
    api.getAdminUsers()
      .then((list) => {
        const u = list.find((x) => x.id === viewUser);
        if (live) setViewName(u ? (u.name ? `${u.name}(${u.email})` : u.email) : null);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [viewUser]);

  const notify = useMemo<NotifyCtl | undefined>(() => (notifyOn == null || readOnly ? undefined : {
    enabled: notifyOn,
    onToggle: (id, on) => {
      setNotice(null);
      void setTelegram(id, on).then((ok) => { if (!ok) setNotice('알림 설정을 바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요.'); });
    },
  }), [notifyOn, readOnly, setTelegram]);

  // 짧은 오류 문구는 몇 초 뒤 사라진다.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  // 웹 알림 소리: 내 세션이 wait·done으로 바뀌면 짧게 울린다(첫 동작 전에는 브라우저가 막아 건너뛴다).
  useEffect(() => { installSoundUnlock(); }, []);
  const prevStatus = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const mine = sessions.filter((s) => !s.sharedBy);
    const prev = prevStatus.current;
    prevStatus.current = new Map(mine.map((s) => [s.id, s.status]));
    if (!prev || readOnly || !isSoundOn()) return;
    const kind = chimeFor(prev, mine);
    if (kind) playChime(kind);
  }, [sessions, loaded, readOnly]);

  const styleOf = useMemo(() => accountStyles(accounts), [accounts]);
  const own = sessions.filter((s) => !s.sharedBy);
  const shared = sessions.filter((s) => !!s.sharedBy);
  const current = sessions.find((s) => s.id === sel) ?? history?.find((s) => s.id === sel) ?? null;
  const inHistory = !!current && !sessions.some((s) => s.id === current.id);
  const alertCount = own.filter(isUnseen).length;
  const activeEmails = useMemo(
    () => new Set(own.filter((s) => s.status === 'run' && s.account).map((s) => s.account as string)),
    [own],
  );

  const open = useCallback((id: string) => {
    const s = sessions.find((x) => x.id === id);
    setSel(id);
    setTab('chat');
    if (s && !readOnly && !s.sharedBy && isWaitLike(s.status) && !s.seen) markSeen(id);
    void openLog(id);
  }, [sessions, markSeen, openLog, readOnly]);

  /** 확인 없이 바로 지운다. 화면에서 먼저 없애고, 서버가 실패하면 되돌린다. */
  const remove = useCallback(async (id: string) => {
    setSel((cur) => (cur === id ? null : cur));
    setNotice(null);
    const ok = await removeSession(id);
    if (!ok) setNotice('세션을 지우지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
  }, [removeSession]);

  const showHistory = useCallback(async () => {
    setView('history');
    setSel(null);
    setHistoryFailed(false);
    const list = await loadHistory();
    if (!list) setHistoryFailed(true);
    return list;
  }, [loadHistory]);

  const showNow = () => { setView('now'); setSel(null); };

  // 바로 열기: /?session=<id> (텔레그램·웹 알림 링크). 로그인 뒤 돌아와도 주소가 남아 있다.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!wanted) { handled.current = null; return; }
    if (!loaded || handled.current === wanted) return;
    handled.current = wanted;
    if (sessions.some((s) => s.id === wanted)) {
      setView('now');
      setMode('detail');
      open(wanted);
      dropSessionParam();
      return;
    }
    // 지금 목록에 없으면(오래전에 끝난 세션) 기록에서 찾는다.
    void showHistory().then((list) => {
      if (list?.some((s) => s.id === wanted && !s.sharedBy)) {
        setMode('detail');
        open(wanted);
      } else {
        setView('now');
        setNotice('그 세션을 찾지 못했습니다. 지워졌거나 볼 수 없는 세션입니다.');
      }
      dropSessionParam();
    });
  }, [wanted, loaded, sessions, open, showHistory, setMode]);

  const openFromDeck = (id: string) => { setMode('detail'); setView('now'); open(id); };

  // 상태 필터가 없으면 세션이 없는 컴퓨터도 묶음 머리를 보인다.
  const groups = groupByMachine(own.filter((s) => passes(filter, s.status)), machines)
    .filter((g) => g.sessions.length > 0 || filter === 'all');
  const sharedShown = shared.filter((s) => passes(filter, s.status));
  const countBy = (f: Filter) => sessions.filter((s) => passes(f, s.status)).length;
  const lastActivity = sessions.reduce<string | null>((m, s) => (!m || s.lastEventAt > m ? s.lastEventAt : m), null);
  const histMachines = data.historyMachines.length ? data.historyMachines : machines;

  const appCls = ['app', theme.cls, current && mode === 'detail' ? 'open' : '', mode === 'deck' ? 'deckmode' : '', readOnly ? 'viewing' : '']
    .filter(Boolean).join(' ');

  const actions = (
    <>
      <button
        type="button"
        className="btn mode-btn"
        onClick={() => setMode(mode === 'deck' ? 'detail' : 'deck')}
        aria-label={mode === 'deck' ? '상세 화면으로' : '간단히 보기로'}
      >
        {mode === 'deck'
          ? <><ListIcon /><span className="btn-text">상세</span></>
          : <><GridIcon /><span className="btn-text">간단히</span></>}
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label={`알림 ${alertCount}건`}
        title="답을 기다리는 세션만 보기"
        onClick={() => { setMode('detail'); setView('now'); setFilter('wait'); }}
      >
        <BellIcon />
        {alertCount > 0 && <span className="badge">{alertCount}</span>}
      </button>
    </>
  );

  const card = (s: SessionView) => (
    <SessionCard
      key={s.id}
      s={s}
      acct={styleOf(s.account)}
      selected={s.id === sel}
      now={now}
      onOpen={open}
      onDelete={readOnly || s.sharedBy ? undefined : remove}
      reply={readOnly || s.sharedBy ? undefined : reply}
    />
  );

  const sharedSession = !!current?.sharedBy;
  const panelNotice = readOnly
    ? '읽기 전용으로 보고 있습니다. 답장·삭제·설정은 바꿀 수 없습니다.'
    : sharedSession ? `${current!.sharedBy}님이 공유한 세션입니다. 보기만 할 수 있습니다.` : null;

  return (
    <div className={appCls}>
      <Header
        me={me}
        page="dashboard"
        dark={theme.dark}
        onToggleTheme={theme.toggle}
        connected={connected}
        mid={mode === 'deck' ? <LimitPills accounts={accounts} styleOf={styleOf} /> : undefined}
        actions={actions}
      />
      {readOnly && (
        <div className="view-band" role="status">
          <EyeIcon size={16} />
          <span className="view-band-text"><b>{viewName ?? '다른 사용자'}</b>님의 대시보드를 보고 있습니다 · 읽기 전용</span>
          <Link className="btn sm" to="/admin#users"><BackIcon size={14} />돌아가기</Link>
        </div>
      )}

      {mode === 'deck' ? (
        <Deck sessions={sessions} machines={machines} styleOf={styleOf} now={now} onOpen={openFromDeck} onDelete={readOnly ? undefined : remove} />
      ) : (
        <div className="wrap">
          {/* 제목 줄은 왼쪽·오른쪽 전체 폭에 걸친다. 그래야 상세 패널 윗선이 첫 카드 윗선과 맞는다. */}
          <div className="dash-title">
            <div className="dash-title-text">
              <h1 className="h1">세션 현황</h1>
              <p className="sub">
                {view === 'history'
                  ? '종료된 세션의 기록입니다. 눌러서 대화를 볼 수 있습니다.'
                  : loaded
                    ? `세션 ${sessions.length}개 · 컴퓨터 ${machines.length}대${lastActivity ? ` · 마지막 활동 ${formatAgo(lastActivity, now)}` : ''}`
                    : '불러오는 중입니다'}
              </p>
            </div>
            <div className="seg view-seg" role="tablist" aria-label="현재와 기록">
              <button type="button" role="tab" aria-selected={view === 'now'} className={view === 'now' ? 'on' : ''} onClick={showNow}>현재</button>
              <button type="button" role="tab" aria-selected={view === 'history'} className={view === 'history' ? 'on' : ''} onClick={() => void showHistory()}>기록</button>
            </div>
          </div>
          <main className="left">
            {view === 'history' ? (
              <HistoryList
                sessions={history}
                machines={histMachines}
                failed={historyFailed}
                styleOf={styleOf}
                sel={sel}
                now={now}
                onOpen={open}
                onDelete={readOnly ? undefined : remove}
                onRetry={() => void showHistory()}
              />
            ) : (
              <>
                <LimitCards
                  accounts={accounts}
                  styleOf={styleOf}
                  activeEmails={activeEmails}
                  expanded={limitsOpen}
                  onToggle={() => setLimitsOpen((v) => !v)}
                  now={now}
                />

                <div className="seg-box">
                  <div className="seg" role="group" aria-label="상태 필터">
                    {FILTERS.map(([k, label]) => (
                      <button type="button" key={k} className={filter === k ? 'on' : ''} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                        <span className={`fdot ${k}`} />{label}<span className="cnt">{countBy(k)}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {loaded && sessions.length === 0 && machines.length === 0 && (
                  <div className="empty">
                    <p>아직 연결된 세션이 없습니다.</p>
                    {!readOnly && <p className="hint">클로드코드에서 <code>/c-monitor:connect {window.location.origin}</code>를 실행해 컴퓨터를 연결해 주세요.</p>}
                  </div>
                )}
                {loaded && sessions.length > 0 && groups.length === 0 && sharedShown.length === 0 && (
                  <div className="empty"><p>이 상태의 세션이 없습니다.</p></div>
                )}

                {groups.map(({ machine: m, sessions: list }) => {
                  const total = own.filter((s) => s.machineId === m.id).length;
                  const meta = [m.os, m.pluginVersion && `플러그인 ${m.pluginVersion}`, `세션 ${total}개`,
                    !m.online && m.lastSeenAt ? `마지막 신호 ${formatAgo(m.lastSeenAt, now)}` : '']
                    .filter(Boolean).join(' · ');
                  return (
                    <section className="group" aria-label={m.name} key={m.id}>
                      <div className="g-head">
                        <span className="g-ico" aria-hidden="true">{isPcOs(m.os) ? <PcIcon size={16} /> : <ServerIcon size={16} />}</span>
                        <div className="g-text">
                          <div className="g-line">
                            <span className="g-name" title={m.name}>{m.name}</span>
                            {m.id !== '__unknown' && (
                              <span className={m.online ? 'tag green' : 'tag neutral'}><span className="dot" />{m.online ? '연결됨' : '오프라인'}</span>
                            )}
                          </div>
                          <div className="g-meta">{meta}</div>
                        </div>
                      </div>
                      {list.length === 0 ? (
                        <p className="g-empty">세션이 없습니다</p>
                      ) : (
                        <div className="cards">{sortSessions(list).map(card)}</div>
                      )}
                    </section>
                  );
                })}

                {sharedShown.length > 0 && (
                  <section className="group" aria-label="공유받은 세션">
                    <div className="g-head">
                      <span className="g-ico" aria-hidden="true"><ShareIcon size={16} /></span>
                      <div className="g-text">
                        <div className="g-line"><span className="g-name">공유받은 세션</span><span className="tag neutral">보기만</span></div>
                        <div className="g-meta">다른 사람이 보여 준 세션입니다 · 세션 {shared.length}개</div>
                      </div>
                    </div>
                    <div className="cards">{sortSessions(sharedShown).map(card)}</div>
                  </section>
                )}
              </>
            )}
          </main>

          <DetailPanel
            key={current?.id ?? 'none'}
            session={current}
            machine={current ? (inHistory ? histMachines : machines).find((m) => m.id === current.machineId) ?? null : null}
            log={current ? logs[current.id] : undefined}
            tab={tab}
            onTab={setTab}
            onClose={() => setSel(null)}
            connected={connected}
            now={now}
            onLoadOlder={current ? () => loadOlder(current.id) : undefined}
            onJump={current ? (seq) => jumpTo(current.id, seq) : undefined}
            onLatest={current ? () => openLog(current.id) : undefined}
            onSearch={current ? (q) => api.searchLog(current.id, q) : undefined}
            onDelete={current && !readOnly && !sharedSession ? () => void remove(current.id) : undefined}
            onShare={current && !readOnly && !sharedSession ? () => setSharing(current.id) : undefined}
            onAck={current && !readOnly && !sharedSession && !inHistory ? () => markSeen(current.id) : undefined}
            reply={readOnly || sharedSession || inHistory ? undefined : reply}
            notify={readOnly || sharedSession || inHistory ? undefined : notify}
            readOnly={readOnly || sharedSession}
            notice={panelNotice}
            replies={current ? replies[current.id] : undefined}
          />
        </div>
      )}
      {sharing && current && sharing === current.id && (
        <ShareDialog s={current} now={now} onClose={() => setSharing(null)} />
      )}
      {notice && <div className="toast" role="alert">{notice}</div>}
    </div>
  );
}
