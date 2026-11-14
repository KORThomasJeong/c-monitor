// 대시보드: 상세 보기(한도 카드·필터·컴퓨터별 묶음·상세 패널)와 간단히 보기(타일)를 오간다.
import type { MeResponse, SessionStatus } from '@c-monitor/shared';
import * as api from '../api/client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Header } from '../components/Header';
import { BellIcon, GridIcon, ListIcon, PcIcon, ServerIcon } from '../components/Icons';
import { LimitCards, LimitPills } from '../components/Limits';
import { SessionCard } from '../components/SessionCard';
import { formatAgo } from '../lib/format';
import { MODE_KEY, useNow, useStoredChoice, useTheme } from '../lib/prefs';
import { accountStyles, groupByMachine, isPcOs, isUnseen, isWaitLike, sortSessions } from '../lib/view';
import { useReplies } from '../state/reply';
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
  const { sessions, machines, accounts, logs, connected, loaded, markSeen, openLog, loadOlder, jumpTo, removeSession } = data;
  const reply = useReplies();
  const theme = useTheme();
  const now = useNow();
  const [mode, setMode] = useStoredChoice(MODE_KEY, MODES, 'detail');
  const [filter, setFilter] = useState<Filter>('all');
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('chat');
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // 짧은 오류 문구는 몇 초 뒤 사라진다.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

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
    void openLog(id);
  }, [sessions, markSeen, openLog]);

  /** 확인 없이 바로 지운다. 화면에서 먼저 없애고, 서버가 실패하면 되돌린다. */
  const remove = useCallback(async (id: string) => {
    setSel((cur) => (cur === id ? null : cur));
    setNotice(null);
    const ok = await removeSession(id);
    if (!ok) setNotice('세션을 지우지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
  }, [removeSession]);

  const openFromDeck = (id: string) => { setMode('detail'); open(id); };

  // 상태 필터가 없으면 세션이 없는 컴퓨터도 묶음 머리를 보인다.
  const groups = groupByMachine(sessions.filter((s) => passes(filter, s.status)), machines)
    .filter((g) => g.sessions.length > 0 || filter === 'all');
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
        <Deck sessions={sessions} machines={machines} styleOf={styleOf} now={now} onOpen={openFromDeck} onDelete={remove} />
      ) : (
        <div className="wrap">
          {/* 제목 줄은 왼쪽·오른쪽 전체 폭에 걸친다. 그래야 상세 패널 윗선이 첫 카드 윗선과 맞는다. */}
          <div className="dash-title">
            <h1 className="h1">세션 현황</h1>
            <p className="sub">
              {loaded
                ? `세션 ${sessions.length}개 · 컴퓨터 ${machines.length}대${lastActivity ? ` · 마지막 활동 ${formatAgo(lastActivity, now)}` : ''}`
                : '불러오는 중입니다'}
            </p>
          </div>
          <main className="left">

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
                    <div className="cards">
                      {sortSessions(list).map((s) => (
                        <SessionCard key={s.id} s={s} acct={styleOf(s.account)} selected={s.id === sel} now={now} onOpen={open} onDelete={remove} reply={reply} />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </main>

          <DetailPanel
            key={current?.id ?? 'none'}
            session={current}
            machine={current ? machines.find((m) => m.id === current.machineId) ?? null : null}
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
            onDelete={current ? () => void remove(current.id) : undefined}
            reply={reply}
          />
        </div>
      )}
      {notice && <div className="toast" role="alert">{notice}</div>}
    </div>
  );
}
