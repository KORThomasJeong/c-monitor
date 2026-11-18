// 세션 카드(상세 화면)와 타일(간단히 보기). 목업 Main의 .card / .tile 구조 그대로.
// 종료·연락 끊김 세션에는 지우기 버튼을 단다. 버튼 안에 버튼을 넣을 수 없어서
// 감싸는 요소(.card-wrap / .tile-wrap) 안에 카드 버튼과 지우기 버튼을 형제로 둔다.
import type { SessionView } from '@c-monitor/shared';
import { formatAgo, formatClock } from '../lib/format';
import { canDelete, cardClass, ctxText, elapsedText, shortTime, statusLabel, tagColor, TAG_COLOR, tileClass, type AccountStyle } from '../lib/view';
import type { ReplyCtl } from '../state/reply';
import { AlertIcon, BellOffIcon, BranchIcon, CheckIcon, CloseIcon, PowerIcon, SendIcon, SpinIcon, WifiOffIcon } from './Icons';
import { PendingReply } from './Reply';

/** 지우기 버튼. 확인 창 없이 한 번 누르면 바로 지운다. */
export function DeleteButton({ onDelete, className = 'del-btn' }: { onDelete: () => void; className?: string }) {
  return (
    <button type="button" className={className} aria-label="세션 지우기" title="세션과 대화 기록을 지웁니다" onClick={onDelete}>
      <CloseIcon size={16} />
    </button>
  );
}

type CardProps = {
  s: SessionView;
  acct: AccountStyle;
  selected: boolean;
  now: number;
  onOpen: (id: string) => void;
  onDelete?: (id: string) => void;
  /** 원격 답장. 없으면 답 버튼을 그리지 않는다. */
  reply?: ReplyCtl;
};

/** 내 세션인데 알림(텔레그램·웹)을 꺼 두었는가(카드에 작은 표시) */
export const telegramOff = (s: SessionView) => s.telegram === false && !s.sharedBy;

/** 카드·타일에 답 버튼을 보일 수 있는가 */
export const canAnswer = (s: SessionView) => !!s.pending && s.canReply;

export function SessionCard({ s, acct, selected, now, onOpen, onDelete, reply }: CardProps) {
  const label = statusLabel(s.status);
  const del = onDelete && canDelete(s.status);
  const answer = !!reply && canAnswer(s);
  const err = reply && !answer ? reply.error(s.id) : null;
  const tgOff = telegramOff(s);
  const wrap = ['card-wrap', del && 'can-del', answer && 'has-reply', answer && cardClass(s, selected).split(' ').filter((c) => c !== 'card').join(' ')]
    .filter(Boolean).join(' ');
  return (
    <div className={wrap}>
      <button
        type="button"
        className={cardClass(s, selected)}
        onClick={() => onOpen(s.id)}
        aria-label={`${s.name} · ${label}${tgOff ? ' · 알림 끔' : ''}`}
        aria-pressed={selected}
      >
        <span className="c-top">
          <span className={`tag ${tagColor(s)}`}><span className="dot" />{label}</span>
          <span className="c-right">
            {tgOff && <span className="c-tgoff" title="알림 끔" data-testid="tg-off"><BellOffIcon size={14} /></span>}
            <span className="c-time">{elapsedText(s, now)}</span>
          </span>
        </span>
        <span className="c-name" title={s.cwd}>{s.name}</span>
        <span className="c-meta">
          <span className={acct.chip}>{acct.label}</span>
          {s.branch && <span className="c-mi"><BranchIcon size={12} />{s.branch}</span>}
          {s.model && <span className="c-mi">{s.model}</span>}
          {s.contextPct != null && <span className="c-mi c-ctx" title="컨텍스트 사용률">컨텍스트 {ctxText(s.contextPct)}</span>}
          {s.sharedBy && <span className="c-mi c-shared" title={`${s.sharedBy}님이 공유한 세션`}>{s.sharedBy} 공유</span>}
        </span>
        {!answer && (
          <span className="c-act">
            {s.activity ? <><b>{s.activity.label}</b> {s.activity.text}</> : <b>활동 기록 없음</b>}
          </span>
        )}
        <span className="c-foot">
          <span>{formatAgo(s.lastEventAt, now)}</span>
          <span>시작 {formatClock(s.startedAt, now)}</span>
        </span>
      </button>
      {answer && reply && s.pending && <PendingReply s={s} pending={s.pending} ctl={reply} compact />}
      {err && <p className="reply-err c-reply-err" role="status">{err}</p>}
      {del && <DeleteButton onDelete={() => onDelete(s.id)} />}
    </div>
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

type TileProps = {
  s: SessionView;
  acct: AccountStyle;
  machineName: string;
  now: number;
  onOpen: (id: string) => void;
  onDelete?: (id: string) => void;
};

export function SessionTile({ s, acct, machineName, now, onOpen, onDelete }: TileProps) {
  const label = statusLabel(s.status);
  const del = onDelete && canDelete(s.status);
  const answer = canAnswer(s);
  const ask = s.pending?.kind === 'question' ? '질문' : '승인';
  return (
    <div className={del ? 'tile-wrap can-del' : 'tile-wrap'}>
      <button
        type="button"
        className={answer ? `${tileClass(s)} can-reply` : tileClass(s)}
        onClick={() => onOpen(s.id)}
        aria-label={answer ? `${s.name} · ${label} · ${ask} 대기 · 눌러서 답하기` : `${s.name} · ${label} · 눌러서 상세 보기`}
      >
        <span className="t-head">
          <span className="t-ico" aria-hidden="true"><TileIcon status={s.status} /></span>
          <span className="t-time">{shortTime(s, now)}</span>
        </span>
        <span className="t-name">{s.name}</span>
        <span className="t-state">
          {label}
          {answer && <span className="t-reply"><SendIcon size={12} />{ask}<span className="t-reply-more"> · 눌러서 답하기</span></span>}
        </span>
        <span className="t-meta">{machineName} · {acct.label}</span>
      </button>
      {del && <DeleteButton onDelete={() => onDelete(s.id)} />}
    </div>
  );
}
