// 세션·계정을 화면 표시용으로 바꾸는 순수 함수들.
import {
  DELETABLE_STATUSES,
  SEARCH_MIN_CHARS,
  STATUS_LABEL,
  STATUS_RANK,
  type AccountView,
  type LogLine,
  type MachineView,
  type ReplyRecord,
  type SessionStatus,
  type SessionView,
} from '@c-monitor/shared';
import { formatAgo, formatDuration } from './format';

/** 태그 색. limit은 wait과 같은 빨강으로 취급한다. */
export const TAG_COLOR: Record<SessionStatus, string> = {
  wait: 'red', limit: 'red', done: 'green', run: 'blue', lost: 'amber', end: 'neutral',
};

/** CSS 상태 클래스(s-*, k-*)에 쓰는 이름. limit은 wait 스타일. */
export const styleKey = (s: SessionStatus): Exclude<SessionStatus, 'limit'> => (s === 'limit' ? 'wait' : s);

export const isWaitLike = (s: SessionStatus) => s === 'wait' || s === 'limit';

/** 빨강 깜박임: 답을 기다리는데 아직 열어 보지 않음. */
export const isUnseen = (s: SessionView) => isWaitLike(s.status) && s.seen === false;

/** 초록 깜박임: 일이 끝났는데 아직 "알람 끄기"를 누르지 않음. */
export const isUnacked = (s: SessionView) => s.status === 'done' && s.seen === false;

export const statusLabel = (s: SessionStatus) => STATUS_LABEL[s];

export function cardClass(s: SessionView, selected: boolean): string {
  let c = `card s-${styleKey(s.status)}`;
  if (isUnseen(s)) c += ' unseen';
  if (isUnacked(s)) c += ' unack';
  if (selected) c += ' sel';
  return c;
}

export function tileClass(s: SessionView): string {
  let c = `tile k-${styleKey(s.status)}`;
  if (isUnseen(s)) c += ' unseen';
  if (isUnacked(s)) c += ' unack';
  return c;
}

/** 정렬: 상태 순위 → 최근 활동 순. */
export function sortSessions(list: SessionView[]): SessionView[] {
  return list.slice().sort((a, b) =>
    STATUS_RANK[a.status] - STATUS_RANK[b.status] || Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt));
}

/** 카드 오른쪽 위 시간. */
export function elapsedText(s: SessionView, now: number): string {
  const since = (iso: string) => Math.max(0, now - Date.parse(iso));
  switch (s.status) {
    case 'run':
    case 'wait':
    case 'limit': {
      const ms = since(s.startedAt);
      return ms < 60_000 ? '방금 시작' : `${formatDuration(ms)}째`;
    }
    case 'done':
      return `${formatAgo(s.lastEventAt, now)} 끝남`;
    case 'lost':
      return `${formatDuration(since(s.lastEventAt))}째 소식 없음`;
    case 'end':
      return `${formatAgo(s.endedAt ?? s.lastEventAt, now)} 종료`;
  }
}

/** 타일용 짧은 시간. */
export function shortTime(s: SessionView, now: number): string {
  if (s.status === 'lost') return `${formatDuration(Math.max(0, now - Date.parse(s.lastEventAt)))} 조용`;
  if (s.status === 'end') return formatAgo(s.endedAt ?? s.lastEventAt, now);
  return elapsedText(s, now);
}

export type AccountStyle = { label: string; chip: string; spark: string };

/** 계정마다 칩 색·짧은 이름. 색은 서버가 준 순서로 번갈아 쓴다(숨긴 계정 포함해 고정). */
export function accountStyles(accounts: AccountView[]): (email: string | null) => AccountStyle {
  const map = new Map<string, AccountStyle>();
  accounts.forEach((a, i) => {
    const eco = i % 2 === 1;
    map.set(a.email, {
      label: a.alias?.trim() || domainOf(a.email),
      chip: eco ? 'chip eco' : 'chip sk',
      spark: eco ? 'spark-line eco' : 'spark-line',
    });
  });
  return (email) => {
    if (!email) return { label: '계정 모름', chip: 'chip sk', spark: 'spark-line' };
    return map.get(email) ?? { label: domainOf(email), chip: 'chip sk', spark: 'spark-line' };
  };
}

export const domainOf = (email: string) => email.split('@')[1] ?? email;

/** 최근 갱신 순(기록 없는 계정은 뒤로). */
export function byRecent(a: AccountView, b: AccountView): number {
  return (b.at ? Date.parse(b.at) : -Infinity) - (a.at ? Date.parse(a.at) : -Infinity);
}

/** 한도 카드에 보일 계정: 숨긴 계정 제외, 4개 넘으면 최근 갱신 4개 + 나머지 수. */
export function limitCards(accounts: AccountView[], expanded: boolean, max = 4): { shown: AccountView[]; rest: number } {
  const visible = accounts.filter((a) => !a.hidden);
  if (visible.length <= max) return { shown: visible, rest: 0 };
  const sorted = visible.slice().sort(byRecent);
  return expanded ? { shown: sorted, rest: sorted.length - max } : { shown: sorted.slice(0, max), rest: sorted.length - max };
}

/** 사용률 단계: 80% 이상 warn, 95% 이상 crit. */
export const level = (p: number | null): '' | 'warn' | 'crit' => (p == null ? '' : p >= 95 ? 'crit' : p >= 80 ? 'warn' : '');

/** 7일 추이 → 240×40 polyline 좌표(목업과 같은 비율). */
export function sparkPoints(history: { sevenDayPct: number }[]): string {
  const y = (v: number) => (38 - Math.max(0, Math.min(100, v)) * 0.36).toFixed(1);
  if (history.length === 0) return '';
  if (history.length === 1) return `0,${y(history[0]!.sevenDayPct)} 240,${y(history[0]!.sevenDayPct)}`;
  const step = 240 / (history.length - 1);
  return history.map((h, i) => `${+(i * step).toFixed(1)},${y(h.sevenDayPct)}`).join(' ');
}

/** 도구 입력을 한 줄로 요약. */
export function toolSummary(input: unknown, fallback = ''): string {
  if (input == null) return firstLine(fallback);
  if (typeof input === 'string') return firstLine(input);
  if (typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) {
      if (typeof o[k] === 'string' && o[k]) return firstLine(o[k] as string);
    }
    try { return firstLine(JSON.stringify(input)); } catch { return ''; }
  }
  return String(input);
}

export function firstLine(text: string, max = 200): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Windows·macOS면 PC 아이콘. 플러그인이 예전에 보낸 process.platform 값(win32·darwin)도 받는다. */
export const isPcOs = (os: string) => /^win|windows|^mac|macos|mac os|darwin/i.test(os.trim());

/** 화면에서 지울 수 있는 상태(종료·연락 끊김). 서버도 같은 기준으로 409를 준다. */
export const canDelete = (s: SessionStatus) => DELETABLE_STATUSES.includes(s);

/** 대화 줄 본문을 찾은 글자 기준으로 조각낸다. 2자 미만이면 나누지 않는다. */
export function splitMatches(text: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim();
  if (Array.from(q).length < SEARCH_MIN_CHARS || !text) return [{ text, hit: false }];
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out.length ? out : [{ text, hit: false }];
}

/**
 * 도구 줄 표시. 본문(text)이 이미 입력 요약이거나 결과이므로 본문을 쓰고, 본문이 없을 때만 입력을 요약한다.
 * head는 한 줄 요약, rest는 여러 줄일 때 펼쳐 볼 전체(한 줄이면 빈 문자열).
 */
export function toolText(line: LogLine): { head: string; rest: string } {
  const body = (line.text ?? '').replace(/^\s*\n/, '').replace(/\n\s*$/, '');
  if (!body.trim()) return { head: toolSummary(line.toolInput), rest: '' };
  const lines = body.split(/\r?\n/);
  const head = (lines.find((l) => l.trim()) ?? '').trim();
  return { head, rest: lines.length > 1 ? body : '' };
}

/** 낱말 뒤에 붙는 "로/으로". 받침이 있으면(ㄹ 받침 제외) "으로". 한글이 아니면 "로". */
export function roParticle(word: string): '로' | '으로' {
  const ch = Array.from(word.trim()).pop();
  if (!ch) return '로';
  const code = ch.codePointAt(0)! - 0xac00;
  if (code < 0 || code > 11171) return '로';
  const jong = code % 28;
  return jong === 0 || jong === 8 ? '로' : '으로';
}

/** 웹·텔레그램 답 기록을 대화 줄 사이에 끼울 한 줄로. 예: "웹에서 「허용」으로 답했습니다" */
export function replyText(r: Pick<ReplyRecord, 'source' | 'kind' | 'label'>): string {
  const from = r.source === 'telegram' ? '텔레그램에서' : '웹에서';
  const label = r.label.trim() || (r.kind === 'message' ? '글' : '답');
  if (r.kind === 'message') return `${from} 글을 보냈습니다 「${label}」`;
  return `${from} 「${label}」${roParticle(label)} 답했습니다`;
}

export type LogItem = { kind: 'line'; line: LogLine } | { kind: 'reply'; reply: ReplyRecord };

/**
 * 대화 줄 사이에 답 기록을 시각 순으로 끼운다. 같은 시각이면 줄 뒤에 둔다.
 * 불러온 범위 밖(앞에 줄이 더 있는데 첫 줄보다 이른 기록, 뒤에 줄이 더 있는데 마지막 줄보다 늦은 기록)은 뺀다.
 */
export function interleave(
  lines: LogLine[], replies: ReplyRecord[] | undefined, range: { hasMoreBefore: boolean; hasMoreAfter: boolean },
): LogItem[] {
  const out: LogItem[] = lines.map((line) => ({ kind: 'line', line }));
  if (!replies?.length) return out;
  const t = (iso: string) => Date.parse(iso) || 0;
  const firstAt = lines.length ? t(lines[0]!.at) : -Infinity;
  const lastAt = lines.length ? t(lines[lines.length - 1]!.at) : Infinity;
  const picked = replies
    .filter((r) => !(range.hasMoreBefore && t(r.at) < firstAt) && !(range.hasMoreAfter && t(r.at) > lastAt))
    .slice()
    .sort((a, b) => t(a.at) - t(b.at));
  if (!picked.length) return out;
  const merged: LogItem[] = [];
  let i = 0;
  for (const item of out) {
    const at = t((item as { line: LogLine }).line.at);
    while (i < picked.length && t(picked[i]!.at) < at) merged.push({ kind: 'reply', reply: picked[i++]! });
    merged.push(item);
  }
  while (i < picked.length) merged.push({ kind: 'reply', reply: picked[i++]! });
  return merged;
}

/** 컨텍스트 사용률 표시. null이면 null. */
export const ctxText = (pct: number | null | undefined) => (pct == null ? null : `${Math.round(pct)}%`);

/** 컴퓨터별 묶음. 컴퓨터 목록 순서를 따르고, 목록에 없는 컴퓨터의 세션은 맨 뒤 묶음으로. */
export function groupByMachine(
  sessions: SessionView[],
  machines: MachineView[],
): { machine: MachineView; sessions: SessionView[] }[] {
  const known = new Set(machines.map((m) => m.id));
  const groups = machines.map((m) => ({ machine: m, sessions: sessions.filter((s) => s.machineId === m.id) }));
  const orphan = sessions.filter((s) => !known.has(s.machineId));
  if (orphan.length) {
    groups.push({
      machine: { id: '__unknown', name: '알 수 없는 컴퓨터', os: '', pluginVersion: '', lastSeenAt: null, online: false, remoteReply: false },
      sessions: orphan,
    });
  }
  return groups;
}
