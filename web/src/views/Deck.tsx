// 간단히 보기(스트림덱 모드): 타일만. 타일을 누르면 상세 모드로 돌아가 그 세션을 연다.
import type { MachineView, SessionView } from '@c-monitor/shared';
import { SessionTile } from '../components/SessionCard';
import { sortSessions, type AccountStyle } from '../lib/view';

type Props = {
  sessions: SessionView[];
  machines: MachineView[];
  styleOf: (email: string | null) => AccountStyle;
  now: number;
  onOpen: (id: string) => void;
  onDelete?: (id: string) => void;
};

/** 타일의 컴퓨터 줄. 공유받은 세션은 남의 컴퓨터라 정보가 없으므로 "○○ 공유"로 보인다. */
export function machineLabel(s: SessionView, nameOf: Map<string, string>): string {
  const name = nameOf.get(s.machineId);
  if (name) return name;
  return s.sharedBy ? `${s.sharedBy} 공유` : '알 수 없는 컴퓨터';
}

export function Deck({ sessions, machines, styleOf, now, onOpen, onDelete }: Props) {
  const nameOf = new Map(machines.map((m) => [m.id, m.name]));
  return (
    <main className={sessions.length > 8 ? "deck many" : "deck"} aria-label="세션 간단히 보기">
      {sessions.length === 0 && <p className="empty deck-empty">표시할 세션이 없습니다.</p>}
      {sortSessions(sessions).map((s) => (
        <SessionTile
          key={s.id}
          s={s}
          acct={styleOf(s.account)}
          machineName={machineLabel(s, nameOf)}
          now={now}
          onOpen={onOpen}
          onDelete={s.sharedBy ? undefined : onDelete}
        />
      ))}
    </main>
  );
}
