// 수집 묶음을 DB에 반영하고, 바뀐 것을 소유자에게만 알린다.
import {
  nextStatus,
  type HookEvent, type IngestBatch, type LogLine, type SessionStatus,
} from '@c-monitor/shared';
import { loadAccountViews, loadMachineViews, loadSessionViews, ONLINE_MS, type SessionRow } from '../query/views';
import type { Deps, Machine } from '../types';
import { head } from '../util';

const ACTIVITY_MAX = 200;

type Activity = { label: string; text: string };

/** 카드에 보일 "마지막 활동 한 줄". 활동을 만들지 않는 이벤트는 null(앞의 것을 유지). */
export function activityOf(e: Pick<HookEvent, 'event' | 'data'>): Activity | null {
  const d = e.data ?? {};
  switch (e.event) {
    case 'UserPromptSubmit':
      return { label: '질문', text: head(d.prompt, ACTIVITY_MAX) };
    case 'PreToolUse': {
      const input = (d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : {}) as Record<string, unknown>;
      const picked = [input.command, input.file_path, input.pattern, input.description]
        .find((v) => typeof v === 'string' && v.length > 0);
      return { label: head(d.tool_name ?? '도구', ACTIVITY_MAX), text: head(picked, ACTIVITY_MAX) };
    }
    case 'Notification':
      // idle_prompt는 상태를 바꾸지 않는 알림이라 "완료" 문구를 덮지 않게 건너뛴다.
      if (d.notification_type === 'idle_prompt') return null;
      return { label: '알림', text: head(d.message, ACTIVITY_MAX) };
    case 'Stop':
      return { label: '완료', text: head(d.last_assistant_message, ACTIVITY_MAX) };
    case 'StopFailure':
      return { label: '실패', text: head(d.error, ACTIVITY_MAX) };
    case 'SessionEnd':
      return { label: '종료', text: head(d.reason, ACTIVITY_MAX) };
    default:
      return null;
  }
}

type SessionState = {
  status: SessionStatus; seen: boolean; account: string | null; cwd: string;
  branch: string | null; model: string | null;
  startedAt: Date; lastEventAt: Date; endedAt: Date | null; activity: Activity | null;
};

/** 이벤트 하나를 세션 상태에 적용한다(순수 함수). */
export function applyEvent(prev: SessionState | null, e: HookEvent, now: Date): SessionState {
  // 기기 시계가 앞서 있어도 서버 시각을 넘지 않게 한다.
  const at = new Date(Math.min(new Date(e.at).getTime(), now.getTime()));
  const status = nextStatus(prev?.status ?? null, e);
  const s: SessionState = prev
    ? { ...prev }
    : {
        status, seen: true, account: null, cwd: e.cwd, branch: e.branch, model: e.model,
        startedAt: at, lastEventAt: at, endedAt: null, activity: null,
      };

  // 답을 기다리게 만든 이벤트가 오면 "아직 안 봄"으로.
  const asksUser = e.event === 'PreToolUse'
    || (e.event === 'Notification' && e.data?.notification_type !== 'idle_prompt');
  if (status === 'wait' && (prev?.status !== 'wait' || asksUser)) s.seen = false;

  s.status = status;
  s.endedAt = status === 'end' ? (prev?.status === 'end' && prev.endedAt ? prev.endedAt : at) : null;
  if (at > s.lastEventAt) s.lastEventAt = at;
  if (at < s.startedAt) s.startedAt = at;
  if (e.account) s.account = e.account;
  if (e.cwd) s.cwd = e.cwd;
  s.branch = e.branch;
  if (e.model) s.model = e.model;
  const activity = activityOf(e);
  if (activity) s.activity = activity;
  return s;
}

const fromRow = (r: SessionRow): SessionState => ({
  status: r.status, seen: r.seen, account: r.account, cwd: r.cwd, branch: r.branch, model: r.model,
  startedAt: r.started_at, lastEventAt: r.last_event_at, endedAt: r.ended_at,
  activity: r.activity_label === null ? null : { label: r.activity_label, text: r.activity_text ?? '' },
});

type LineInsert = {
  session_id: string; seq: number; role: LogLine['role']; at: string; text: string;
  tool_name: string | null; tool_input: unknown; truncated: boolean; masked: number;
};

export async function applyBatch(deps: Deps, machine: Machine, batch: IngestBatch): Promise<{ accepted: number }> {
  const { sql } = deps;
  const now = deps.now();
  const userId = machine.userId;
  const sid = (claudeSessionId: string) => `${machine.id}:${claudeSessionId}`;

  const out = await sql.begin(async (tx) => {
    // 기기 행을 먼저 갱신한다. 이 행 잠금이 같은 기기의 동시 전송을 줄 세운다.
    await tx`
      UPDATE machines SET name = ${batch.machine.name}, os = ${batch.machine.os},
        plugin_version = ${batch.machine.pluginVersion}, last_seen_at = ${now}
      WHERE id = ${machine.id}`;

    // 처음 보는 이벤트 id만 고른다(멱등).
    const fresh = new Set<string>();
    const ids = [...new Set(batch.events.map((e) => e.id))];
    if (ids.length > 0) {
      const rows = await tx<{ id: string }[]>`
        INSERT INTO event_ids (machine_id, id, at)
        SELECT ${machine.id}, x, ${now} FROM json_array_elements_text(${tx.json(ids)}::json) AS x
        ON CONFLICT DO NOTHING RETURNING id`;
      for (const r of rows) fresh.add(r.id);
    }
    const events = batch.events.filter((e) => fresh.delete(e.id));
    // 이미 받은 이벤트가 섞여 있는 세션 = 예전에 받은 묶음을 다시 보낸 것.
    const accepted = new Set(events);
    const resent = new Set(batch.events.filter((e) => !accepted.has(e)).map((e) => sid(e.sessionId)));

    // 이 묶음이 건드리는 세션들의 현재 상태.
    const touched = [...new Set([...events.map((e) => sid(e.sessionId)), ...batch.transcript.map((t) => sid(t.sessionId))])];
    const states = new Map<string, SessionState>();
    if (touched.length > 0) {
      const rows = await tx<SessionRow[]>`SELECT * FROM sessions WHERE id IN ${tx(touched)}`;
      for (const r of rows) states.set(r.id, fromRow(r));
    }

    const dirty = new Set<string>();
    for (const e of events) {
      const id = sid(e.sessionId);
      states.set(id, applyEvent(states.get(id) ?? null, e, now));
      dirty.add(id);
    }
    // 이벤트 없이 대화만 먼저 온 세션은 최소한의 행을 만들어 둔다.
    // 다만 다시 보낸 묶음인데 세션이 없다면 사용자가 그 세션을 지운 것이다 — 대화만으로 되살리지 않는다.
    const dropped = new Set<string>();
    for (const t of batch.transcript) {
      const id = sid(t.sessionId);
      if (states.has(id)) continue;
      if (resent.has(id)) {
        dropped.add(id);
        continue;
      }
      const first = t.lines[0] ? new Date(Math.min(new Date(t.lines[0].at).getTime(), now.getTime())) : now;
      states.set(id, {
        status: 'done', seen: true, account: null, cwd: '', branch: null, model: null,
        startedAt: first, lastEventAt: first, endedAt: null, activity: null,
      });
      dirty.add(id);
    }

    for (const id of dirty) {
      const s = states.get(id)!;
      await tx`
        INSERT INTO sessions (id, user_id, machine_id, account, cwd, branch, model, status, seen,
                              started_at, last_event_at, ended_at, activity_label, activity_text)
        VALUES (${id}, ${userId}, ${machine.id}, ${s.account}, ${s.cwd}, ${s.branch}, ${s.model}, ${s.status}, ${s.seen},
                ${s.startedAt}, ${s.lastEventAt}, ${s.endedAt}, ${s.activity?.label ?? null}, ${s.activity?.text ?? null})
        ON CONFLICT (id) DO UPDATE SET
          account = EXCLUDED.account, cwd = EXCLUDED.cwd, branch = EXCLUDED.branch, model = EXCLUDED.model,
          status = EXCLUDED.status, seen = EXCLUDED.seen, started_at = EXCLUDED.started_at,
          last_event_at = EXCLUDED.last_event_at, ended_at = EXCLUDED.ended_at,
          activity_label = EXCLUDED.activity_label, activity_text = EXCLUDED.activity_text`;
    }

    // 클로드 계정: 이벤트와 한도에 나온 것을 모두 등록한다.
    const emails = [...new Set([
      ...events.map((e) => e.account).filter((a): a is string => !!a),
      ...(batch.limits ? [batch.limits.account] : []),
    ])];
    const accountsChanged = new Set<string>();
    if (emails.length > 0) {
      const rows = await tx<{ email: string }[]>`
        INSERT INTO accounts (user_id, email)
        SELECT ${userId}, x FROM json_array_elements_text(${tx.json(emails)}::json) AS x
        ON CONFLICT DO NOTHING RETURNING email`;
      for (const r of rows) accountsChanged.add(r.email);
    }

    // 대화 줄: (session_id, seq) 중복은 무시하고 새로 들어간 것만 돌려받는다.
    const lineRows: LineInsert[] = [];
    for (const t of batch.transcript) {
      if (dropped.has(sid(t.sessionId))) continue;
      t.lines.forEach((l, i) => {
        lineRows.push({
          session_id: sid(t.sessionId), seq: t.seq + i, role: l.role, at: l.at, text: l.text,
          tool_name: l.toolName ?? null, tool_input: l.toolInput ?? null,
          truncated: l.truncated ?? false, masked: l.masked ?? 0,
        });
      });
    }
    const newLines = new Map<string, LogLine[]>();
    if (lineRows.length > 0) {
      const inserted = await tx<{ session_id: string; seq: number }[]>`
        INSERT INTO transcript_lines (session_id, seq, role, at, text, tool_name, tool_input, truncated, masked)
        SELECT session_id, seq, role, at, text, tool_name, tool_input, truncated, masked
        FROM json_to_recordset(${tx.json(lineRows as never)}::json) AS r(
          session_id text, seq integer, role text, at timestamptz, text text,
          tool_name text, tool_input jsonb, truncated boolean, masked integer)
        ON CONFLICT (session_id, seq) DO NOTHING
        RETURNING session_id, seq`;
      const got = new Set(inserted.map((r) => `${r.session_id}\n${r.seq}`));
      for (const r of lineRows) {
        if (!got.delete(`${r.session_id}\n${r.seq}`)) continue;
        const line: LogLine = { seq: r.seq, role: r.role, at: r.at, text: r.text };
        if (r.tool_name !== null) line.toolName = r.tool_name;
        if (r.tool_input !== null) line.toolInput = r.tool_input;
        if (r.truncated) line.truncated = true;
        if (r.masked > 0) line.masked = r.masked;
        const list = newLines.get(r.session_id) ?? [];
        list.push(line);
        newLines.set(r.session_id, list);
      }
    }

    if (batch.limits) {
      const l = batch.limits;
      const rows = await tx`
        INSERT INTO limits (user_id, account, five_pct, five_resets, seven_pct, seven_resets, at)
        VALUES (${userId}, ${l.account}, ${l.fiveHourPct}, ${l.fiveHourResetsAt}, ${l.sevenDayPct}, ${l.sevenDayResetsAt}, ${l.at})
        ON CONFLICT DO NOTHING RETURNING account`;
      if (rows.length > 0) accountsChanged.add(l.account);
    }

    return { accepted: events.length, dirty: [...dirty], newLines, accountsChanged: [...accountsChanged] };
  });

  // ── 커밋 뒤: 소유자에게만 알린다 ──────────────────────────
  for (const { session } of await loadSessionViews(sql, out.dirty)) {
    deps.bus.publish(userId, { type: 'session', session });
  }
  for (const [sessionId, lines] of out.newLines) {
    lines.sort((a, b) => a.seq - b.seq);
    deps.bus.publish(userId, { type: 'log', sessionId, lines });
  }
  for (const email of out.accountsChanged) {
    const [account] = await loadAccountViews(sql, userId, now, email);
    if (account) deps.bus.publish(userId, { type: 'limits', account });
  }
  // 기기는 매 훅마다 알리면 시끄러우니, 다시 온라인이 됐거나 정보가 바뀐 때만 알린다.
  const wasOnline = machine.lastSeenAt !== null && now.getTime() - machine.lastSeenAt.getTime() <= ONLINE_MS;
  const infoChanged = machine.name !== batch.machine.name || machine.os !== batch.machine.os
    || machine.pluginVersion !== batch.machine.pluginVersion;
  if (!wasOnline || infoChanged) {
    const [view] = await loadMachineViews(sql, userId, now, { id: machine.id });
    if (view) deps.bus.publish(userId, { type: 'machine', machine: view });
  }

  return { accepted: out.accepted };
}
