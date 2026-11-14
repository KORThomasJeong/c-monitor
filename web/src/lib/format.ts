// 화면에 쓰는 시간·코드 표시 함수. 모두 순수 함수라 now를 받아서 계산한다.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

const pad = (n: number) => String(n).padStart(2, '0');

/** 경과 시간을 "1시간 8분", "42분" 꼴로. 1분이 안 되면 "1분 미만". */
export function formatDuration(ms: number): string {
  if (ms < MIN) return '1분 미만';
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / MIN);
  if (d > 0) return h > 0 ? `${d}일 ${h}시간` : `${d}일`;
  if (h > 0) return m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
  return `${m}분`;
}

/** 초기화까지 남은 시간. resetsAt은 epoch 초. 예: "2시간 13분 뒤", "47분 뒤", "지남". */
export function formatRemaining(resetsAt: number | null, nowMs: number): string {
  if (resetsAt == null) return '알 수 없음';
  const diff = resetsAt * 1000 - nowMs;
  if (diff <= 0) return '지남';
  if (diff < MIN) return '1분 안';
  return `${formatDuration(diff)} 뒤`;
}

/** 한도 카드 아래 문구. 하루 안이면 남은 시간, 넘으면 요일과 시각. */
export function formatResetLabel(resetsAt: number | null, nowMs: number): string {
  if (resetsAt == null) return '초기화 시간 모름';
  const diff = resetsAt * 1000 - nowMs;
  if (diff <= 0) return '초기화 시간 지남';
  if (diff < DAY) return `${formatRemaining(resetsAt, nowMs)} 초기화`;
  const d = new Date(resetsAt * 1000);
  return `${WEEKDAYS[d.getDay()]}요일 ${pad(d.getHours())}:${pad(d.getMinutes())} 초기화`;
}

/** 지난 시각을 "방금", "25초 전", "4분 전" 꼴로. */
export function formatAgo(iso: string | null, nowMs: number): string {
  if (!iso) return '기록 없음';
  const diff = Math.max(0, nowMs - Date.parse(iso));
  if (diff < 10_000) return '방금';
  if (diff < MIN) return `${Math.floor(diff / 1000)}초 전`;
  if (diff < HOUR) return `${Math.floor(diff / MIN)}분 전`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}시간 전`;
  return `${Math.floor(diff / DAY)}일 전`;
}

/** 시각을 "오늘 09:02", "어제 21:10", "11월 12일 09:02" 꼴로. */
export function formatClock(iso: string | null, nowMs: number): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date(nowMs);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return `오늘 ${hm}`;
  if (sameDay(d, new Date(nowMs - DAY))) return `어제 ${hm}`;
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${hm}`;
}

/** "HH:MM"만. */
export function formatTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 사람이 입력한 연결 코드를 "XXXX-XXXX" 꼴로 다듬는다. */
export function normalizeUserCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

/** 바이트를 "418MB", "1.2GB", "12KB" 꼴로. */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  const s = i === 0 || v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
  return `${s}${units[i]}`;
}

/** 용량 한도(MB). 0이면 "무제한". */
export const formatQuota = (mb: number) => (mb <= 0 ? '무제한' : formatBytes(mb * 1024 * 1024));

/** 비용(USD) "$3.12". */
export const formatUsd = (v: number) => `$${v.toFixed(2)}`;

/** 날짜와 시각 "2026년 11월 21일 09:02". */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
