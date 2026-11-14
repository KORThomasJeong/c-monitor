// 계정별 사용 한도: 상세 화면의 카드(.lim)와 간단히 보기 헤더의 알약(.lp).
import type { AccountView } from '@c-monitor/shared';
import { formatAgo, formatResetLabel } from '../lib/format';
import { byRecent, level, limitCards, sparkPoints, type AccountStyle } from '../lib/view';

type StyleOf = (email: string | null) => AccountStyle;

function Meter({ label, pct, resetsAt, now }: { label: string; pct: number | null; resetsAt: number | null; now: number }) {
  const lvl = level(pct);
  const shown = pct == null ? null : Math.round(pct);
  return (
    <div className="meter">
      <div className="meter-top">
        <span className="meter-label">{label}</span>
        {pct != null && pct >= 80 && (
          <span className={pct >= 95 ? 'tag red' : 'tag amber'}><span className="dot" />{pct >= 95 ? '거의 다 씀' : '80% 넘음'}</span>
        )}
      </div>
      <div className="meter-val">{shown ?? '—'}<span className="pct">%</span></div>
      <div className="bar" role="img" aria-label={shown == null ? `${label} 기록 없음` : `${label} ${shown}퍼센트 사용`}>
        <div className={lvl ? `bar-fill ${lvl}` : 'bar-fill'} style={{ width: `${shown ?? 0}%` }} />
      </div>
      <div className="meter-foot">{formatResetLabel(resetsAt, now)}</div>
    </div>
  );
}

function LimitCard({ a, style, active, now }: { a: AccountView; style: AccountStyle; active: boolean; now: number }) {
  const h = a.history;
  const range = h.length ? `${Math.round(h[0]!.sevenDayPct)}% → ${Math.round(h[h.length - 1]!.sevenDayPct)}%` : '기록 없음';
  return (
    <article className="lim">
      <div className="lim-head">
        <span className={style.chip}>{style.label}</span>
        <span className="lim-name" title={a.email}>{a.email}</span>
        {active && <span className="tag blue"><span className="dot" />지금 사용 중</span>}
        <span className="lim-plan">{a.at ? `${formatAgo(a.at, now)} 갱신` : '아직 기록 없음'}</span>
      </div>
      <div className="meters">
        <Meter label="5시간 한도" pct={a.fiveHourPct} resetsAt={a.fiveHourResetsAt} now={now} />
        <Meter label="주간 한도" pct={a.sevenDayPct} resetsAt={a.sevenDayResetsAt} now={now} />
      </div>
      <div className="spark">
        <div className="spark-head"><span>주간 사용량 · 최근 7일</span><span>{range}</span></div>
        <svg className="spark-svg" viewBox="0 0 240 40" preserveAspectRatio="none" role="img" aria-label="주간 사용량 7일 추이">
          {h.length > 0 && <polyline className={style.spark} points={sparkPoints(h)} />}
        </svg>
      </div>
    </article>
  );
}

type CardsProps = {
  accounts: AccountView[];
  styleOf: StyleOf;
  /** 지금 작업 중인 세션이 쓰는 계정 */
  activeEmails: Set<string>;
  expanded: boolean;
  onToggle: () => void;
  now: number;
};

export function LimitCards({ accounts, styleOf, activeEmails, expanded, onToggle, now }: CardsProps) {
  const { shown, rest } = limitCards(accounts, expanded);
  if (shown.length === 0) return null;
  return (
    <section className="limits" aria-label="계정별 사용 한도">
      {shown.map((a) => (
        <LimitCard key={a.email} a={a} style={styleOf(a.email)} active={activeEmails.has(a.email)} now={now} />
      ))}
      {rest > 0 && (
        <button type="button" className="btn sm lim-more" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? '접기' : `외 ${rest}개`}
        </button>
      )}
    </section>
  );
}

/** 간단히 보기 헤더 가운데: 최근 갱신 계정 2개까지 + "외 N". */
export function LimitPills({ accounts, styleOf }: { accounts: AccountView[]; styleOf: StyleOf }) {
  const visible = accounts.filter((a) => !a.hidden).sort(byRecent);
  const shown = visible.slice(0, 2);
  const rest = visible.length - shown.length;
  const pct = (p: number | null) => (p == null ? '—' : `${Math.round(p)}%`);
  return (
    <div className="hdr-mid">
      <div className="lpills">
        {shown.map((a) => {
          const st = styleOf(a.email);
          return (
            <span className="lp" role="group" key={a.email} aria-label={`${a.email} 사용 한도`}>
              <span className={st.chip}>{st.label}</span>
              <span>5시간 <b className={level(a.fiveHourPct)}>{pct(a.fiveHourPct)}</b></span>
              <span>주간 <b className={level(a.sevenDayPct)}>{pct(a.sevenDayPct)}</b></span>
            </span>
          );
        })}
        {rest > 0 && <span className="lp lp-more">외 {rest}</span>}
      </div>
    </div>
  );
}
