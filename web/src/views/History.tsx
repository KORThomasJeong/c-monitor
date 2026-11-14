// 기록 탭: 종료된 세션 목록(검색어·컴퓨터 필터, 지우기). 누르면 읽기 전용 상세.
import type { MachineView, SessionView } from '@c-monitor/shared';
import { useMemo, useState } from 'react';
import { SessionCard } from '../components/SessionCard';
import { CloseIcon, SearchIcon } from '../components/Icons';
import type { AccountStyle } from '../lib/view';

type Props = {
  /** null = 불러오는 중 */
  sessions: SessionView[] | null;
  machines: MachineView[];
  failed: boolean;
  styleOf: (email: string | null) => AccountStyle;
  sel: string | null;
  now: number;
  onOpen: (id: string) => void;
  /** 없으면 지우기 버튼을 그리지 않는다(관리자가 남의 기록을 볼 때) */
  onDelete?: (id: string) => void;
  onRetry: () => void;
};

/** 기록 탭에 보일 세션: 종료된 것(공유받은 세션은 뺀다), 최근 종료 순. */
export function endedSessions(list: SessionView[]): SessionView[] {
  return list
    .filter((s) => s.status === 'end' && !s.sharedBy)
    .sort((a, b) => Date.parse(b.endedAt ?? b.lastEventAt) - Date.parse(a.endedAt ?? a.lastEventAt));
}

export function HistoryList({ sessions, machines, failed, styleOf, sel, now, onOpen, onDelete, onRetry }: Props) {
  const [q, setQ] = useState('');
  const [machine, setMachine] = useState('');
  const ended = useMemo(() => endedSessions(sessions ?? []), [sessions]);
  const names = new Map(machines.map((m) => [m.id, m.name]));
  const usedMachines = machines.filter((m) => ended.some((s) => s.machineId === m.id));
  const needle = q.trim().toLowerCase();
  const shown = ended.filter((s) =>
    (!machine || s.machineId === machine)
    && (!needle || [s.name, s.cwd, s.branch ?? '', s.model ?? '', s.activity?.text ?? ''].some((t) => t.toLowerCase().includes(needle))));

  return (
    <section className="history" aria-label="기록">
      <div className="h-filters" role="search">
        <label className="s-field h-search">
          <SearchIcon size={16} />
          <input
            type="search"
            className="s-input"
            aria-label="기록 검색"
            placeholder="폴더·브랜치·모델로 찾기"
            value={q}
            maxLength={200}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQ(''); }}
          />
          {q && <button type="button" className="s-clear" aria-label="검색 지우기" onClick={() => setQ('')}><CloseIcon size={16} /></button>}
        </label>
        <select className="input select h-machine" aria-label="컴퓨터 필터" value={machine} onChange={(e) => setMachine(e.target.value)}>
          <option value="">모든 컴퓨터</option>
          {usedMachines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>

      {sessions === null && !failed && <p className="empty">기록을 불러오는 중입니다.</p>}
      {failed && (
        <div className="empty">
          <p>기록을 불러오지 못했습니다.</p>
          <button type="button" className="btn sm" style={{ marginTop: 12 }} onClick={onRetry}>다시 시도</button>
        </div>
      )}
      {sessions && !failed && ended.length === 0 && <div className="empty"><p>종료된 세션이 없습니다.</p></div>}
      {sessions && !failed && ended.length > 0 && shown.length === 0 && <div className="empty"><p>조건에 맞는 세션이 없습니다.</p></div>}
      {shown.length > 0 && (
        <>
          <p className="hint h-count">종료된 세션 {shown.length}개{shown.length !== ended.length ? ` · 전체 ${ended.length}개 중` : ''}</p>
          <div className="cards">
            {shown.map((s) => (
              <div className="h-item" key={s.id}>
                <SessionCard s={s} acct={styleOf(s.account)} selected={s.id === sel} now={now} onOpen={onOpen} onDelete={onDelete} />
                <span className="h-machine-name hint">{names.get(s.machineId) ?? '알 수 없는 컴퓨터'}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
