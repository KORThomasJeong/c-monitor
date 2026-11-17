// 수집 묶음을 DB에 반영하고, 바뀐 것을 소유자에게만 알린다.
import {
  nextStatus,
  type HookEvent, type IngestBatch, type LogLine, type SessionStat, type SessionStatus,
} from '@c-monitor/shared';
import { loadAccountViews, loadMachineViews, loadSessionViews, ONLINE_MS, type SessionRow } from '../query/views';
import { notifyLimits, notifySessionChanges, type StatusChange } from '../notify/notify';
import { tryDeliver } from '../reply/deliver';
import type { Deps, Machine } from '../types';
import { head } from '../util';

const ACTIVITY_MAX = 200;
/** 텔레그램 알림에 붙이는 마지막 답·알림 문구의 최대 길이. */
const ACTIVITY_NOTE_MAX = 300;

/**
 * 이 이벤트가 오면, 그보다 먼저 등록된 승인·질문은 터미널에서 이미 답한 것이다(계획의 동작 규칙 3-②).
 * PreToolUse는 넣지 않는다 — 등록과 순서가 뒤바뀌어 올 수 있다.
 */
const CLEARS_REQUESTS: ReadonlySet<HookEvent['event']> = new Set([
  'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd',
]);

/** 서브에이전트가 낸 이벤트면 그 id, 메인 세션이면 null. */
const agentOf = (e: Pick<HookEvent, 'data'>): string | null =>
  typeof e.data?.agent_id === 'string' && e.data.agent_id.length > 0 ? e.data.agent_id : null;

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
  remoteUrl: string | null;
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
        startedAt: at, lastEventAt: at, endedAt: null, activity: null, remoteUrl: null,
      };

  // 답을 기다리게 만든 이벤트가 오면 "아직 안 봄"으로.
  const asksUser = e.event === 'PreToolUse'
    || (e.event === 'Notification' && e.data?.notification_type !== 'idle_prompt');
  if (status === 'wait' && (prev?.status !== 'wait' || asksUser)) s.seen = false;
  // 일이 끝났으면(Stop) "알람 끄기"를 누를 때까지 초록 깜박임. 새로 열린 세션(SessionStart)은 깜박이지 않는다.
  const finished = e.event === 'Stop' || e.event === 'StopFailure';
  if (status === 'done' && finished && prev?.status !== 'done') s.seen = false;

  s.status = status;
  s.endedAt = status === 'end' ? (prev?.status === 'end' && prev.endedAt ? prev.endedAt : at) : null;
  if (at > s.lastEventAt) s.lastEventAt = at;
  if (at < s.startedAt) s.startedAt = at;
  if (e.account) s.account = e.account;
  if (e.cwd) s.cwd = e.cwd;
  s.branch = e.branch;
  if (e.model) s.model = e.model;
  // 원격 제어 주소: 필드가 없으면(옛 플러그인) 그대로 두고, null이면 지운다.
  if (e.remoteUrl !== undefined) s.remoteUrl = e.remoteUrl;
  const activity = activityOf(e);
  if (activity) s.activity = activity;
  return s;
}

const fromRow = (r: SessionRow): SessionState => ({
  status: r.status, seen: r.seen, account: r.account, cwd: r.cwd, branch: r.branch, model: r.model,
  startedAt: r.started_at, lastEventAt: r.last_event_at, endedAt: r.ended_at,
  activity: r.activity_label === null ? null : { label: r.activity_label, text: r.activity_text ?? '' },
  remoteUrl: r.remote_url,
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
    const received = batch.events.filter((e) => fresh.delete(e.id));

    // 이 묶음이 건드리는 세션들의 현재 상태와, 사용자가 지운 세션의 표시.
    const touched = [...new Set([...received.map((e) => sid(e.sessionId)), ...batch.transcript.map((t) => sid(t.sessionId))])];
    const states = new Map<string, SessionState>();
    /** 이 묶음을 반영하기 전의 상태(없던 세션은 들어 있지 않다). */
    const statusBefore = new Map<string, SessionStatus>();
    const deletedAt = new Map<string, number>();
    if (touched.length > 0) {
      const rows = await tx<SessionRow[]>`SELECT * FROM sessions WHERE id IN ${tx(touched)}`;
      for (const r of rows) {
        states.set(r.id, fromRow(r));
        statusBefore.set(r.id, r.status);
      }
      const gone = await tx<{ session_id: string; deleted_at: Date }[]>`
        SELECT session_id, deleted_at FROM deleted_sessions WHERE session_id IN ${tx(touched)}`;
      for (const r of gone) deletedAt.set(r.session_id, r.deleted_at.getTime());
    }

    // 지운 세션은 지운 뒤에 생긴 "움직임"이 있을 때만 되살린다.
    // 지우기 전 시각의 이벤트(큐에 남아 있다 늦게 온 것)와 종료 알림(SessionEnd)만으로는 카드를 다시 만들지 않는다.
    const afterDelete = (e: HookEvent, id: string) => new Date(e.at).getTime() > deletedAt.get(id)!;
    const revived = new Set<string>();
    for (const e of received) {
      const id = sid(e.sessionId);
      if (deletedAt.has(id) && e.event !== 'SessionEnd' && afterDelete(e, id)) revived.add(id);
    }
    const events = received.filter((e) => {
      const id = sid(e.sessionId);
      return !deletedAt.has(id) || (revived.has(id) && afterDelete(e, id));
    });
    if (revived.size > 0) await tx`DELETE FROM deleted_sessions WHERE session_id IN ${tx([...revived])}`;

    const dirty = new Set<string>();
    /** 세션마다 이 묶음에서 거친 상태들(알림 판단용)과, 알림에 붙일 한 줄. */
    const trail = new Map<string, SessionStatus[]>();
    const noteOf = new Map<string, string>();
    for (const e of events) {
      const id = sid(e.sessionId);
      const next = applyEvent(states.get(id) ?? null, e, now);
      states.set(id, next);
      dirty.add(id);
      trail.set(id, [...(trail.get(id) ?? []), next.status]);
      const note = e.event === 'Stop' ? e.data?.last_assistant_message
        : e.event === 'Notification' && e.data?.notification_type !== 'idle_prompt' ? e.data?.message : undefined;
      if (typeof note === 'string' && note.trim()) noteOf.set(id, head(note, ACTIVITY_NOTE_MAX));
    }
    // 이벤트 없이 대화만 먼저 온 세션은 최소한의 행을 만들어 둔다.
    // 다만 지운 세션(되살아나지 않은 것)의 대화는 받지 않는다.
    const dropped = new Set<string>();
    for (const t of batch.transcript) {
      const id = sid(t.sessionId);
      if (states.has(id)) continue;
      if (deletedAt.has(id)) {
        dropped.add(id);
        continue;
      }
      const first = t.lines[0] ? new Date(Math.min(new Date(t.lines[0].at).getTime(), now.getTime())) : now;
      states.set(id, {
        status: 'done', seen: true, account: null, cwd: '', branch: null, model: null,
        startedAt: first, lastEventAt: first, endedAt: null, activity: null, remoteUrl: null,
      });
      dirty.add(id);
    }

    // ── 원격 답장: 뒤따른 이벤트로 끝난 승인·질문 치우기 ─────────
    // 같은 세션·같은 에이전트에서 요청보다 뒤의 이벤트가 왔으면 터미널에서 먼저 답한 것이다 → gone.
    // 세션이 끝났으면(SessionEnd) 에이전트를 가리지 않고 모두 치운다.
    type Clear = { sessionId: string; agent: string | null; all: boolean; at: string };
    const clears = new Map<string, Clear>();
    for (const e of events) {
      if (!CLEARS_REQUESTS.has(e.event)) continue;
      const sessionId = sid(e.sessionId);
      const all = e.event === 'SessionEnd';
      const agent = all ? null : agentOf(e);
      const key = JSON.stringify([sessionId, all, agent]);
      const cur = clears.get(key);
      if (!cur || new Date(e.at).getTime() > new Date(cur.at).getTime()) clears.set(key, { sessionId, agent, all, at: e.at });
    }
    const goneRequests: string[] = [];
    for (const c of clears.values()) {
      const rows = await tx<{ id: string }[]>`
        UPDATE reply_requests SET status = 'gone'
        WHERE status = 'pending' AND session_id = ${c.sessionId} AND created_at < ${c.at}
          ${c.all ? tx`` : tx`AND agent_id IS NOT DISTINCT FROM ${c.agent}`}
        RETURNING id`;
      for (const r of rows) goneRequests.push(r.id);
    }

    const dirtyIds = [...dirty];
    if (dirtyIds.length > 0) {
      // 아직 기다리는 승인·질문이 남아 있으면 그 세션은 여전히 답을 기다린다.
      // (등록보다 늦게 도착한 PreToolUse 따위가 "작업 중"으로 되돌리지 않게 한다)
      const waiting = await tx<{ session_id: string }[]>`
        SELECT DISTINCT session_id FROM reply_requests WHERE status = 'pending' AND session_id IN ${tx(dirtyIds)}`;
      for (const { session_id } of waiting) {
        const s = states.get(session_id)!;
        if (s.status !== 'run') continue;
        s.status = 'wait';
        if (statusBefore.get(session_id) !== 'wait') s.seen = false;
      }
      // 끝난 세션에 쌓여 있던 글은 전달할 곳이 없다. (같은 id로 다시 이어져도 옛 글이 튀어나오지 않게 버린다)
      const ended = dirtyIds.filter((id) => states.get(id)!.status === 'end');
      if (ended.length > 0) await tx`DELETE FROM session_messages WHERE delivered_at IS NULL AND session_id IN ${tx(ended)}`;
    }

    for (const id of dirty) {
      const s = states.get(id)!;
      await tx`
        INSERT INTO sessions (id, user_id, machine_id, account, cwd, branch, model, status, seen,
                              started_at, last_event_at, ended_at, activity_label, activity_text, remote_url)
        VALUES (${id}, ${userId}, ${machine.id}, ${s.account}, ${s.cwd}, ${s.branch}, ${s.model}, ${s.status}, ${s.seen},
                ${s.startedAt}, ${s.lastEventAt}, ${s.endedAt}, ${s.activity?.label ?? null}, ${s.activity?.text ?? null},
                ${s.remoteUrl})
        ON CONFLICT (id) DO UPDATE SET
          account = EXCLUDED.account, cwd = EXCLUDED.cwd, branch = EXCLUDED.branch, model = EXCLUDED.model,
          status = EXCLUDED.status, seen = EXCLUDED.seen, started_at = EXCLUDED.started_at,
          last_event_at = EXCLUDED.last_event_at, ended_at = EXCLUDED.ended_at,
          activity_label = EXCLUDED.activity_label, activity_text = EXCLUDED.activity_text,
          remote_url = EXCLUDED.remote_url`;
    }

    // ── 상태줄의 컨텍스트 %·비용(3차) ─────────────────────
    // 이 기기의 세션에만 반영한다(세션 id 앞에 기기 id가 붙어 남의 세션은 가리킬 수 없다).
    // 모르는 세션(아직 행이 없거나 지운 세션)은 조용히 건너뛴다. 값이 바뀐 세션만 다시 내보낸다.
    const latestStat = new Map<string, SessionStat>();
    for (const st of batch.sessionStats ?? []) {
      const cur = latestStat.get(st.sessionId);
      if (!cur || new Date(st.at).getTime() >= new Date(cur.at).getTime()) latestStat.set(st.sessionId, st);
    }
    const statChanged: string[] = [];
    for (const st of latestStat.values()) {
      const rows = await tx<{ id: string }[]>`
        UPDATE sessions SET context_pct = ${st.contextPct}, cost_usd = ${st.costUsd}, stats_at = ${st.at}
        WHERE id = ${sid(st.sessionId)} AND user_id = ${userId} AND machine_id = ${machine.id}
          AND (stats_at IS NULL OR stats_at <= ${st.at})
          AND (context_pct IS DISTINCT FROM ${st.contextPct}::double precision
               OR cost_usd IS DISTINCT FROM ${st.costUsd}::double precision)
        RETURNING id`;
      for (const r of rows) statChanged.push(r.id);
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

    let limitsInserted = false;
    if (batch.limits) {
      const l = batch.limits;
      const rows = await tx`
        INSERT INTO limits (user_id, account, five_pct, five_resets, seven_pct, seven_resets, at)
        VALUES (${userId}, ${l.account}, ${l.fiveHourPct}, ${l.fiveHourResetsAt}, ${l.sevenDayPct}, ${l.sevenDayResetsAt}, ${l.at})
        ON CONFLICT DO NOTHING RETURNING account`;
      if (rows.length > 0) {
        accountsChanged.add(l.account);
        limitsInserted = true;
      }
    }

    // 텔레그램 알림에 쓸 상태 바뀜. 기다림은 다른 상태에서 wait가 된 것, 끝남은 이 묶음 안에서 작업 중(run·wait)을 거쳐 done이 된 것만.
    const changes: StatusChange[] = [];
    for (const id of dirtyIds) {
      const from = statusBefore.get(id) ?? null;
      const to = states.get(id)!.status;
      const passed = [from, ...(trail.get(id) ?? []).slice(0, -1)];
      const worked = (trail.get(id)?.length ?? 0) > 0 && passed.some((x) => x === 'run' || x === 'wait');
      if ((to === 'wait' && passed.some((x) => x !== 'wait')) || (to === 'done' && worked)) {
        changes.push({ sessionId: id, from, to, text: noteOf.get(id) });
      }
    }

    return {
      accepted: events.length, dirty: [...new Set([...dirtyIds, ...statChanged])], changes, limitsInserted, newLines, accountsChanged: [...accountsChanged], goneRequests,
      done: dirtyIds.filter((id) => states.get(id)!.status === 'done'),
      ended: dirtyIds.filter((id) => states.get(id)!.status === 'end'),
    };
  });

  // 치워진 승인·질문을 붙잡고 있던 wait 요청과, 끝난 세션의 inbox 대기자를 바로 풀어 준다.
  deps.reply.notifyRequests(out.goneRequests);
  for (const id of out.ended) deps.reply.dropInbox({ sessionId: id });

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

  // 텔레그램 알림(큐에 넣기만 하고 기다리지 않는다).
  notifySessionChanges(deps, out.changes);
  if (out.limitsInserted && batch.limits) notifyLimits(deps, userId, batch.limits);

  // 세션이 done이 됐으면 쌓여 있던 글을 대기자에게 넘겨 본다(넘기면 세션을 다시 내보낸다).
  for (const id of out.done) {
    await tryDeliver(deps, id).catch((err) => console.error('[reply] 글 전달 실패:', err));
  }

  return { accepted: out.accepted };
}
