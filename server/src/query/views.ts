// DB 행 → 계약의 뷰 타입. 조회 API·스트림·수집이 함께 쓴다.
import type {
  AccountView, DashboardSnapshot, LogLine, MachineView, SessionStatus, SessionView, SettingsView,
} from '@c-monitor/shared';
import type { Q } from '../types';

export const ONLINE_MS = 10 * 60_000;
export const DEFAULT_SETTINGS: SettingsView = { lostMinutes: 10, endHours: 24, keepChatDays: 30, keepUsageDays: 90 };
const HISTORY_DAYS = 7;
const HISTORY_SESSION_LIMIT = 500;

export type SessionRow = {
  id: string; user_id: string; machine_id: string; account: string | null; cwd: string;
  branch: string | null; model: string | null; status: SessionStatus; seen: boolean;
  started_at: Date; last_event_at: Date; ended_at: Date | null;
  activity_label: string | null; activity_text: string | null;
};

/** 카드 제목: cwd의 마지막 폴더 이름(Windows·POSIX 경로 모두). */
export function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? cwd;
}

export function toSessionView(r: SessionRow): SessionView {
  return {
    id: r.id,
    machineId: r.machine_id,
    account: r.account,
    cwd: r.cwd,
    name: folderName(r.cwd),
    branch: r.branch,
    model: r.model,
    status: r.status,
    seen: r.seen,
    startedAt: r.started_at.toISOString(),
    lastEventAt: r.last_event_at.toISOString(),
    endedAt: r.ended_at ? r.ended_at.toISOString() : null,
    activity: r.activity_label === null ? null : { label: r.activity_label, text: r.activity_text ?? '' },
  };
}

/** 세션 id들의 뷰를 소유자와 함께 돌려준다(publish용). */
export async function loadSessionViews(sql: Q, ids: string[]): Promise<{ userId: string; session: SessionView }[]> {
  if (ids.length === 0) return [];
  const rows = await sql<SessionRow[]>`SELECT * FROM sessions WHERE id IN ${sql(ids)}`;
  return rows.map((r) => ({ userId: r.user_id, session: toSessionView(r) }));
}

export async function loadSettings(sql: Q, userId: string): Promise<SettingsView> {
  const [r] = await sql<{ lost_minutes: number; end_hours: number; keep_chat_days: number; keep_usage_days: number }[]>`
    SELECT lost_minutes, end_hours, keep_chat_days, keep_usage_days FROM settings WHERE user_id = ${userId}`;
  if (!r) return { ...DEFAULT_SETTINGS };
  return { lostMinutes: r.lost_minutes, endHours: r.end_hours, keepChatDays: r.keep_chat_days, keepUsageDays: r.keep_usage_days };
}

type MachineRow = {
  id: string; name: string; os: string; plugin_version: string; last_seen_at: Date | null; remote_reply: boolean;
};

export async function loadMachineViews(
  sql: Q, userId: string, now: Date, opts: { id?: string; includeRevoked?: boolean } = {},
): Promise<MachineView[]> {
  const rows = await sql<MachineRow[]>`
    SELECT id, name, os, plugin_version, last_seen_at, remote_reply FROM machines
    WHERE user_id = ${userId}
      ${opts.id ? sql`AND id = ${opts.id}` : sql``}
      ${opts.includeRevoked ? sql`` : sql`AND revoked_at IS NULL`}
    ORDER BY created_at, id`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    os: r.os,
    pluginVersion: r.plugin_version,
    lastSeenAt: r.last_seen_at ? r.last_seen_at.toISOString() : null,
    online: r.last_seen_at !== null && now.getTime() - r.last_seen_at.getTime() <= ONLINE_MS,
    remoteReply: r.remote_reply,
  }));
}

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

/** 계정별 최신 한도 + 최근 7일 주간 사용률(하루 1점, 한국 시간 기준 날짜). */
export async function loadAccountViews(sql: Q, userId: string, now: Date, email?: string): Promise<AccountView[]> {
  const rows = await sql<{
    email: string; alias: string | null; hidden: boolean;
    five_pct: number | null; five_resets: string | null; seven_pct: number | null; seven_resets: string | null;
    at: Date | null;
  }[]>`
    SELECT a.email, a.alias, a.hidden, l.five_pct, l.five_resets, l.seven_pct, l.seven_resets, l.at
    FROM accounts a
    LEFT JOIN LATERAL (
      SELECT five_pct, five_resets, seven_pct, seven_resets, at FROM limits
      WHERE user_id = a.user_id AND account = a.email ORDER BY at DESC LIMIT 1
    ) l ON true
    WHERE a.user_id = ${userId} ${email ? sql`AND a.email = ${email}` : sql``}
    ORDER BY l.at DESC NULLS LAST, a.email`;
  if (rows.length === 0) return [];

  const since = new Date(now.getTime() - HISTORY_DAYS * 24 * 60 * 60_000);
  const hist = await sql<{ account: string; at: Date; seven_pct: number }[]>`
    SELECT DISTINCT ON (account, day) account, at, seven_pct
    FROM (
      SELECT account, at, seven_pct, (at AT TIME ZONE 'Asia/Seoul')::date AS day
      FROM limits
      WHERE user_id = ${userId} AND at > ${since} ${email ? sql`AND account = ${email}` : sql``}
    ) x
    ORDER BY account, day, at DESC`;
  const byAccount = new Map<string, AccountView['history']>();
  for (const p of hist) {
    const list = byAccount.get(p.account) ?? [];
    list.push({ at: p.at.toISOString(), sevenDayPct: p.seven_pct });
    byAccount.set(p.account, list);
  }

  return rows.map((r) => ({
    email: r.email,
    alias: r.alias,
    hidden: r.hidden,
    fiveHourPct: r.five_pct,
    fiveHourResetsAt: num(r.five_resets),
    sevenDayPct: r.seven_pct,
    sevenDayResetsAt: num(r.seven_resets),
    at: r.at ? r.at.toISOString() : null,
    history: byAccount.get(r.email) ?? [],
  }));
}

/**
 * 대시보드 한 화면분. 기본은 폐기된 기기와 그 세션, 그리고 종료된 지 end_hours가 지난 세션을 뺀다.
 * history=true면 모두 포함한다(기록 탭).
 */
export async function loadSnapshot(
  sql: Q, userId: string, now: Date, opts: { history?: boolean } = {},
): Promise<DashboardSnapshot> {
  const settings = await loadSettings(sql, userId);
  const cutoff = new Date(now.getTime() - settings.endHours * 60 * 60_000);
  const [sessionRows, machines, accounts] = await Promise.all([
    opts.history
      ? sql<SessionRow[]>`
          SELECT * FROM sessions WHERE user_id = ${userId}
          ORDER BY last_event_at DESC LIMIT ${HISTORY_SESSION_LIMIT}`
      : sql<SessionRow[]>`
          SELECT s.* FROM sessions s JOIN machines m ON m.id = s.machine_id
          WHERE s.user_id = ${userId} AND m.revoked_at IS NULL
            AND NOT (s.status = 'end' AND s.ended_at IS NOT NULL AND s.ended_at < ${cutoff})
          ORDER BY s.last_event_at DESC`,
    loadMachineViews(sql, userId, now, { includeRevoked: opts.history }),
    loadAccountViews(sql, userId, now),
  ]);
  return { sessions: sessionRows.map(toSessionView), machines, accounts };
}

type LineRow = {
  seq: number; role: LogLine['role']; at: Date; text: string;
  tool_name: string | null; tool_input: unknown; truncated: boolean; masked: number;
};

export function toLogLine(r: LineRow): LogLine {
  const line: LogLine = { seq: r.seq, role: r.role, at: r.at.toISOString(), text: r.text };
  if (r.tool_name !== null) line.toolName = r.tool_name;
  if (r.tool_input !== null && r.tool_input !== undefined) line.toolInput = r.tool_input;
  if (r.truncated) line.truncated = true;
  if (r.masked > 0) line.masked = r.masked;
  return line;
}

export async function loadLog(sql: Q, sessionId: string, after: number, limit: number): Promise<LogLine[]> {
  const rows = await sql<LineRow[]>`
    SELECT seq, role, at, text, tool_name, tool_input, truncated, masked FROM transcript_lines
    WHERE session_id = ${sessionId} AND seq > ${after}
    ORDER BY seq LIMIT ${limit}`;
  return rows.map(toLogLine);
}
