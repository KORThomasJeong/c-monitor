// 세션 카드(상세 화면)와 타일(간단히 보기). 목업 Main의 .card / .tile 구조 그대로.
import type { SessionView } from '@c-monitor/shared';
import { formatAgo, formatClock } from '../lib/format';
import { cardClass, elapsedText, shortTime, statusLabel, TAG_COLOR, tileClass, type AccountStyle } from '../lib/view';
import { AlertIcon, BranchIcon, CheckIcon, PowerIcon, SpinIcon, WifiOffIcon } from './Icons';

type CardProps = {
  s: SessionView;
  acct: AccountStyle;
  selected: boolean;
  now: number;
  onOpen: (id: string) => void;
};

export function SessionCard({ s, acct, selected, now, onOpen }: CardProps) {
  const label = statusLabel(s.status);
  return (
    <button type="button" className={cardClass(s, selected)} onClick={() => onOpen(s.id)} aria-label={`${s.name} · ${label}`} aria-pressed={selected}>
      <span className="c-top">
        <span className={`tag ${TAG_COLOR[s.status]}`}><span className="dot" />{label}</span>
        <span className="c-time">{elapsedText(s, now)}</span>
      </span>
      <span className="c-name" title={s.cwd}>{s.name}</span>
      <span className="c-meta">
        <span className={acct.chip}>{acct.label}</span>
        {s.branch && <span className="c-mi"><BranchIcon size={12} />{s.branch}</span>}
        {s.model && <span className="c-mi">{s.model}</span>}
      </span>
      <span className="c-act">
        {s.activity ? <><b>{s.activity.label}</b> {s.activity.text}</> : <b>활동 기록 없음</b>}
      </span>
      <span className="c-foot">
        <span>{formatAgo(s.lastEventAt, now)}</span>
        <span>시작 {formatClock(s.startedAt, now)}</span>
      </span>
    </button>
  );
}

function TileIcon({ status }: { status: SessionView['status'] }) {
  switch (status) {
    case 'wait':
    case 'limit': return <AlertIcon />;
    case 'done': return <CheckIcon />;
    case 'run': return <SpinIcon />;
    case 'lost': return <WifiOffIcon />;
    case 'end': return <PowerIcon />;
  }
}

type TileProps = { s: SessionView; acct: AccountStyle; machineName: string; now: number; onOpen: (id: string) => void };

export function SessionTile({ s, acct, machineName, now, onOpen }: TileProps) {
  const label = statusLabel(s.status);
  return (
    <button type="button" className={tileClass(s)} onClick={() => onOpen(s.id)} aria-label={`${s.name} · ${label} · 눌러서 상세 보기`}>
      <span className="t-head">
        <span className="t-ico" aria-hidden="true"><TileIcon status={s.status} /></span>
        <span className="t-time">{shortTime(s, now)}</span>
      </span>
      <span className="t-name">{s.name}</span>
      <span className="t-state">{label}</span>
      <span className="t-meta">{machineName} · {acct.label}</span>
    </button>
  );
}
