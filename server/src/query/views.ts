// DB 행 → 계약의 뷰 타입. 조회 API·스트림·수집이 함께 쓴다.
import type { AccountView, DashboardSnapshot, LogLine, LogResponse, MachineView, SessionStatus, SessionView, SettingsView } from '@c-monitor/shared';
import { machineCanReply, statusCanReply, toPendingView, type PendingRow } from '../reply/pending';
import type { Bus, Q } from '../types';

export const ONLINE_MS = 10 * 60_000;
export const DEFAULT_SETTINGS: SettingsView = { lostMinutes: 10, endHours: 24, keepChatDays: 30, keepUsageDays: 90 };
const HISTORY_DAYS = 7;
const HISTORY_SESSION_LIMIT = 500;

export type SessionRow = {
  id: string; user_id: string; machine_id: string; account: string | null; cwd: string;
  branch: string | null; model: string | null; status: SessionStatus; seen: boolean;
  started_at: Date; last_event_at: Date; ended_at: Date | null;
  activity_label: string | null; activity_text: string | null;
  remote_url: string | null;
};

/** 세션 뷰의 원격 답장 부분. 소유자가 아닌 사람에게 가는 뷰는 NO_REPLY를 쓴다. */
export type ReplyInfo = Pick<SessionView, 'pending' | 'canReply' | 'queuedMessages'>;
const NO_REPLY: ReplyInfo = { pending: null, canReply: false, queuedMessages: 0 };

/** 카드 제목: cwd의 마지막 폴더 이름(Windows·POSIX 경로 모두). */
export function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? cwd;
}

export function toSessionView(r: SessionRow, reply: ReplyInfo = NO_REPLY): SessionView {
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
    pending: reply.pending,
    canReply: reply.canReply,
    queuedMessages: reply.queuedMessages,
    remoteUrl: r.remote_url,
  };
}

/**
 * 세션 행들을 뷰로 바꾼다. 원격 답장 정보(기다리는 요청·답할 수 있는지·쌓인 글)는
 * 보는 사람(viewerId)이 그 세션의 소유자일 때만 채운다. viewerId를 주지 않으면 소유자가 보는 것으로 한다.
 */
export async function toSessionViews(sql: Q, rows: SessionRow[], viewerId?: string): Promise<SessionView[]> {
  const own = rows.filter((r) => viewerId === undefined || r.user_id === viewerId);
  const info = new Map<string, ReplyInfo>();
  if (own.length > 0) {
    const ids = own.map((r) => r.id);
    const machineIds = [...new Set(own.map((r) => r.machine_id))];
    const [machines, pendings, queued] = await Promise.all([
      sql<{ id: string; remote_reply: boolean; plugin_version: string; revoked_at: Date | null }[]>`
        SELECT id, remote_reply, plugin_version, revoked_at FROM machines WHERE id IN ${sql(machineIds)}`,
      // 세션마다 가장 오래된 요청 하나와, 함께 기다리는 요청 수.
      sql<(PendingRow & { total: number })[]>`
        SELECT DISTINCT ON (session_id) id, session_id, kind, tool_name, tool_input, questions, session_allow, created_at,
               (count(*) OVER (PARTITION BY session_id))::int AS total
        FROM reply_requests WHERE status = 'pending' AND session_id IN ${sql(ids)}
        ORDER BY session_id, created_at, id`,
      sql<{ session_id: string; n: number }[]>`
        SELECT session_id, count(*)::int AS n FROM session_messages
        WHERE delivered_at IS NULL AND session_id IN ${sql(ids)} GROUP BY session_id`,
    ]);
    const machineOk = new Map(machines.map((m) => [
      m.id, machineCanReply({ remoteReply: m.remote_reply, revoked: m.revoked_at !== null, pluginVersion: m.plugin_version }),
    ]));
    const pendingOf = new Map(pendings.map((p) => [p.session_id, toPendingView(p, p.total - 1)]));
    const queuedOf = new Map(queued.map((q) => [q.session_id, q.n]));
    for (const r of own) {
      const canAnswer = machineOk.get(r.machine_id) ?? false;
      info.set(r.id, {
        // 답할 수 없는 컴퓨터의 요청은 보여 주지 않는다(눌러도 409가 될 뿐이다).
        pending: canAnswer ? pendingOf.get(r.id) ?? null : null,
        canReply: canAnswer && statusCanReply(r.status),
        queuedMessages: queuedOf.get(r.id) ?? 0,
      });
    }
  }
  return rows.map((r) => toSessionView(r, info.get(r.id)));
}

/** 세션 id들의 뷰를 소유자와 함께 돌려준다(publish용 — 소유자가 보는 모양). */
export async function loadSessionViews(sql: Q, ids: string[]): Promise<{ userId: string; session: SessionView }[]> {
  if (ids.length === 0) return [];
  const rows = await sql<SessionRow[]>`SELECT * FROM sessions WHERE id IN ${sql(ids)}`;
  const views = await toSessionViews(sql, rows);
  return rows.map((r, i) => ({ userId: r.user_id, session: views[i]! }));
}

/** 바뀐 세션들을 소유자에게 다시 내보낸다. */
export async function publishSessions(deps: { sql: Q; bus: Bus }, ids: Iterable<string>): Promise<void> {
  for (const { userId, session } of await loadSessionViews(deps.sql, [...new Set(ids)])) {
    deps.bus.publish(userId, { type: 'session', session });
  }
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
 * viewerId는 보는 사람 — 남의 것을 보는 경우(관리자 열람)에는 원격 답장 정보를 비운다. 기본은 본인.
 */
export async function loadSnapshot(
  sql: Q, userId: string, now: Date, opts: { history?: boolean; viewerId?: string } = {},
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
  return { sessions: await toSessionViews(sql, sessionRows, opts.viewerId ?? userId), machines, accounts };
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

const LINE_COLUMNS = ['seq', 'role', 'at', 'text', 'tool_name', 'tool_input', 'truncated', 'masked'] as const;

/** 어디를 볼지. null이면 가장 최근 줄. */
export type LogCursor = { before: number } | { after: number } | { around: number } | null;

/**
 * 대화를 페이지 단위로 읽는다. lines는 항상 seq 오름차순.
 * - null: 가장 최근 limit줄
 * - before: 그 seq보다 앞선 줄 중 가장 가까운 limit줄
 * - after: 그 seq보다 뒤 줄을 앞에서부터 limit줄
 * - around: 그 seq가 가운데 오도록 앞뒤 합쳐 limit줄(한쪽이 모자라면 다른 쪽으로 채운다)
 */
export async function loadLogPage(sql: Q, sessionId: string, cursor: LogCursor, limit: number): Promise<LogResponse> {
  const newestBefore = (seq: number | null, n: number) => sql<LineRow[]>`
    SELECT ${sql(LINE_COLUMNS)} FROM transcript_lines
    WHERE session_id = ${sessionId} ${seq === null ? sql`` : sql`AND seq < ${seq}`}
    ORDER BY seq DESC LIMIT ${n}`;
  const oldestFrom = (seq: number, inclusive: boolean, n: number) => sql<LineRow[]>`
    SELECT ${sql(LINE_COLUMNS)} FROM transcript_lines
    WHERE session_id = ${sessionId} AND ${inclusive ? sql`seq >= ${seq}` : sql`seq > ${seq}`}
    ORDER BY seq LIMIT ${n}`;

  let rows: LineRow[];
  // 돌려준 줄이 없을 때 "앞·뒤에 더 있는지"를 가르는 경계: lo보다 작으면 앞, hi보다 크면 뒤.
  let lo = 0;
  let hi = -1;
  if (cursor === null) {
    rows = [...(await newestBefore(null, limit))].reverse();
  } else if ('before' in cursor) {
    rows = [...(await newestBefore(cursor.before, limit))].reverse();
    lo = cursor.before;
    hi = cursor.before - 1;
  } else if ('after' in cursor) {
    rows = [...(await oldestFrom(cursor.after, false, limit))];
    lo = cursor.after + 1;
    hi = cursor.after;
  } else {
    const [older, newer] = await Promise.all([newestBefore(cursor.around, limit), oldestFrom(cursor.around, true, limit)]);
    // 앞쪽은 절반만, 뒤쪽이 모자라면 그만큼 앞쪽을 더 쓴다.
    const takeOlder = Math.min(older.length, Math.max(Math.floor(limit / 2), limit - newer.length));
    const takeNewer = Math.min(newer.length, limit - takeOlder);
    rows = [...older.slice(0, takeOlder).reverse(), ...newer.slice(0, takeNewer)];
    lo = cursor.around;
    hi = cursor.around - 1;
  }
  if (rows.length > 0) {
    lo = rows[0]!.seq;
    hi = rows[rows.length - 1]!.seq;
  }

  const [count] = await sql<{ total: number; before: number; after: number }[]>`
    SELECT count(*)::int AS total,
           (count(*) FILTER (WHERE seq < ${lo}))::int AS before,
           (count(*) FILTER (WHERE seq > ${hi}))::int AS after
    FROM transcript_lines WHERE session_id = ${sessionId}`;
  return {
    lines: rows.map(toLogLine),
    total: count?.total ?? 0,
    hasMoreBefore: (count?.before ?? 0) > 0,
    hasMoreAfter: (count?.after ?? 0) > 0,
  };
}
