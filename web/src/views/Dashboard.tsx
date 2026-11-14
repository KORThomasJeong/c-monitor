// 대시보드: 상세 보기(한도 카드·필터·컴퓨터별 묶음·상세 패널)와 간단히 보기(타일)를 오간다.
import type { MeResponse, SessionStatus } from '@c-monitor/shared';
import { useCallback, useMemo, useState } from 'react';
import { Header } from '../components/Header';
import { BellIcon, GridIcon, ListIcon, PcIcon, ServerIcon } from '../components/Icons';
import { LimitCards, LimitPills } from '../components/Limits';
import { SessionCard } from '../components/SessionCard';
import { formatAgo } from '../lib/format';
import { MODE_KEY, useNow, useStoredChoice, useTheme } from '../lib/prefs';
import { accountStyles, groupByMachine, isPcOs, isUnseen, isWaitLike, sortSessions } from '../lib/view';
import { useDashboard } from '../state/store';
import { Deck } from './Deck';
import { DetailPanel, type Tab } from './DetailPanel';

type Filter = 'all' | 'wait' | 'done' | 'run' | 'lost' | 'end';
const FILTERS: [Filter, string][] = [
  ['all', '전체'], ['wait', '기다림'], ['done', '끝남'], ['run', '작업 중'], ['lost', '끊김'], ['end', '종료'],
];
/** "기다림" 필터에는 한도 초과도 넣는다(같은 빨강 취급). */
const passes = (f: Filter, s: SessionStatus) => f === 'all' || (f === 'wait' ? isWaitLike(s) : s === f);

const MODES = ['detail', 'deck'] as const;

export function Dashboard({ me }: { me: MeResponse }) {
  const data = useDashboard();
  const { sessions, machines, accounts, logs, connected, loaded, markSeen, loadLog } = data;
  const theme = useTheme();
  const now = useNow();
  const [mode, setMode] = useStoredChoice(MODE_KEY, MODES, 'detail');
  const [filter, setFilter] = useState<Filter>('all');
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('chat');
  const [limitsOpen, setLimitsOpen] = useState(false);

  const styleOf = useMemo(() => accountStyles(accounts), [accounts]);
  const current = sessions.find((s) => s.id === sel) ?? null;
  const alertCount = sessions.filter(isUnseen).length;
  const activeEmails = useMemo(
    () => new Set(sessions.filter((s) => s.status === 'run' && s.account).map((s) => s.account as string)),
    [sessions],
  );

  const open = useCallback((id: string) => {
    const s = sessions.find((x) => x.id === id);
    setSel(id);
    setTab('chat');
    if (s && isWaitLike(s.status) && !s.seen) markSeen(id);
    void loadLog(id);
  }, [sessions, markSeen, loadLog]);

  const openFromDeck = (id: string) => { setMode('detail'); open(id); };

  const groups = groupByMachine(sessions.filter((s) => passes(filter, s.status)), machines)
    .filter((g) => g.sessions.length > 0);
  const countBy = (f: Filter) => sessions.filter((s) => passes(f, s.status)).length;
  const lastActivity = sessions.reduce<string | null>((m, s) => (!m || s.lastEventAt > m ? s.lastEventAt : m), null);

  const appCls = ['app', theme.cls, current && mode === 'detail' ? 'open' : '', mode === 'deck' ? 'deckmode' : '']
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
        onClick={() => { setMode('detail'); setFilter('wait'); }}
      >
        <BellIcon />
        {alertCount > 0 && <span className="badge">{alertCount}</span>}
      </button>
    </>
  );

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

      {mode === 'deck' ? (
        <Deck sessions={sessions} machines={machines} styleOf={styleOf} now={now} onOpen={openFromDeck} />
      ) : (
        <div className="wrap">
          <main className="left">
            <div>
              <h1 className="h1">세션 현황</h1>
              <p className="sub">
                {loaded
                  ? `세션 ${sessions.length}개 · 컴퓨터 ${machines.length}대${lastActivity ? ` · 마지막 활동 ${formatAgo(lastActivity, now)}` : ''}`
                  : '불러오는 중입니다'}
              </p>
            </div>

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

            {loaded && sessions.length === 0 && (
              <div className="empty">
                <p>아직 연결된 세션이 없습니다.</p>
                <p className="hint">클로드코드에서 <code>/c-monitor:connect {window.location.origin}</code>를 실행해 컴퓨터를 연결해 주세요.</p>
              </div>
            )}
            {loaded && sessions.length > 0 && groups.length === 0 && (
              <div className="empty"><p>이 상태의 세션이 없습니다.</p></div>
            )}

            {groups.map(({ machine: m, sessions: list }) => {
              const total = sessions.filter((s) => s.machineId === m.id).length;
              const meta = [m.os, m.pluginVersion && `플러그인 ${m.pluginVersion}`, `세션 ${total}개`,
                !m.online && m.lastSeenAt ? `마지막 신호 ${formatAgo(m.lastSeenAt, now)}` : '']
                .filter(Boolean).join(' · ');
              return (
                <section className="group" aria-label={m.name} key={m.id}>
                  <div className="g-head">
                    <span className="g-ico" aria-hidden="true">{isPcOs(m.os) ? <PcIcon size={16} /> : <ServerIcon size={16} />}</span>
                    <div className="g-text">
                      <div className="g-name">{m.name}</div>
                      <div className="g-meta">{meta}</div>
                    </div>
                    <span className={m.online ? 'tag green' : 'tag neutral'}><span className="dot" />{m.online ? '연결됨' : '오프라인'}</span>
                  </div>
                  <div className="cards">
                    {sortSessions(list).map((s) => (
                      <SessionCard key={s.id} s={s} acct={styleOf(s.account)} selected={s.id === sel} now={now} onOpen={open} />
                    ))}
                  </div>
                </section>
              );
            })}
          </main>

          <DetailPanel
            session={current}
            machine={current ? machines.find((m) => m.id === current.machineId) ?? null : null}
            lines={current ? logs[current.id] : undefined}
            tab={tab}
            onTab={setTab}
            onClose={() => setSel(null)}
            connected={connected}
            now={now}
          />
        </div>
      )}
    </div>
  );
}
