// 웹에서 보낸 글을 세션의 inbox 대기자에게 넘긴다(계획의 동작 규칙 4)와, 넘긴 글의 수신 확인(ack, 3차).
import { publishSessions } from '../query/views';
import type { Deps } from '../types';
import { versionAtLeast } from './pending';

type DeliverDeps = Pick<Deps, 'sql' | 'bus' | 'now' | 'reply'>;

/** 수신 확인(ack)을 보내는 가장 낮은 플러그인 버전. 그보다 낮은 기기는 넘긴 순간 전달 완료로 본다. */
export const INBOX_ACK_MIN_PLUGIN = '0.3.0';
/** 넘긴 글에 이 시간(초) 안에 ack가 없으면 다음 대기자에게 다시 준다. */
export const INBOX_ACK_SECONDS = 60;

/**
 * 그 세션에 쌓인 글 가운데 가장 오래된 하나를 대기자에게 넘긴다. → 넘겼으면 true.
 * 넘기는 조건: 대기자가 붙어 있고, 세션이 done이고, 컴퓨터의 원격 답장이 켜져 있다.
 * - 0.3.0 미만 기기: 넘긴 순간 delivered_at을 찍고 본문을 비운다. 세션은 다시 일하므로 run으로 바꾼다.
 * - 0.3.0 이상 기기: handed_at만 찍는다. ack가 오면 전달 완료(본문 삭제·run). ack 없이 INBOX_ACK_SECONDS가 지나면
 *   다음 대기자에게 다시 준다(세션은 done 그대로라 다음 대기자가 붙으면 바로 받는다).
 *
 * 부르는 곳: inbox 대기자가 붙을 때, 웹에서 글을 보낼 때, 수집에서 세션이 done이 될 때.
 */
export async function tryDeliver(deps: DeliverDeps, sessionId: string): Promise<boolean> {
  const hub = deps.reply;
  // 같은 세션의 전달 시도는 하나씩만 돈다. 도는 중에 또 불리면 끝난 뒤 한 번 더 살핀다.
  if (!hub.beginDelivery(sessionId)) return false;
  let delivered = false;
  try {
    do {
      delivered = await deliverOnce(deps, sessionId);
    } while (hub.endDelivery(sessionId, !delivered));
  } catch (err) {
    hub.endDelivery(sessionId, false);
    throw err;
  }
  if (delivered) await publishSessions(deps, [sessionId]);
  return delivered;
}

async function deliverOnce(deps: DeliverDeps, sessionId: string): Promise<boolean> {
  // 전달을 시도하는 동안에는 대기자를 목록에서 꺼내 둔다 — 이 대기자에게 글을 줄 수 있는 곳은 여기 하나뿐이다.
  const waiter = deps.reply.takeInbox(sessionId);
  if (!waiter) return false;
  let delivered = false;
  /** 대기자를 잡아 둔 글(커밋 뒤에 응답으로 내보낸다). */
  let claimed: { id: string; text: string } | null = null;
  try {
    delivered = await deps.sql.begin(async (tx) => {
      const now = deps.now();
      const retryBefore = new Date(now.getTime() - INBOX_ACK_SECONDS * 1000);
      const [m] = await tx<{ id: string; text: string; plugin_version: string; handed_at: Date | null }[]>`
        SELECT m.id, m.text, mc.plugin_version, m.handed_at FROM session_messages m
        JOIN sessions s ON s.id = m.session_id
        JOIN machines mc ON mc.id = s.machine_id
        WHERE m.session_id = ${sessionId} AND m.delivered_at IS NULL
          AND s.status = 'done' AND mc.remote_reply AND mc.revoked_at IS NULL
        ORDER BY m.created_at, m.id LIMIT 1
        FOR UPDATE OF m SKIP LOCKED`;
      if (!m) return false;
      // 가장 오래된 글을 넘겼고 아직 확인을 기다리는 중이면 그 뒤 글도 건너뛰지 않고 기다린다(순서 유지).
      if (m.handed_at && m.handed_at >= retryBefore) return false;
      // 그 사이 대기자가 끝났으면(시간 초과·연결 끊김) 글은 그대로 쌓아 둔다.
      if (!waiter.claim()) return false;
      claimed = { id: m.id, text: m.text };
      if (versionAtLeast(m.plugin_version, INBOX_ACK_MIN_PLUGIN)) {
        await tx`UPDATE session_messages SET handed_at = ${now} WHERE id = ${m.id}`;
        return true;
      }
      await tx`UPDATE session_messages SET delivered_at = ${now}, handed_at = ${now}, text = '' WHERE id = ${m.id}`;
      await tx`
        UPDATE sessions SET status = 'run', last_event_at = GREATEST(last_event_at, ${now})
        WHERE id = ${sessionId} AND status = 'done'`;
      return true;
    });
  } finally {
    // 넘긴 표시가 커밋된 뒤에 글을 응답으로 내보낸다. 저장에 실패했으면 글은 쌓인 채로 두고 대기자만 끝낸다.
    const msg = claimed as { id: string; text: string } | null;
    if (delivered && msg) waiter.finish({ status: 'message', id: msg.id, text: msg.text });
    else if (msg) waiter.finish({ status: 'pending' });
    else deps.reply.returnInbox(waiter);
  }
  return delivered;
}

/**
 * 넘긴 글의 수신 확인. 그 기기·그 세션에 넘긴 글이면 전달 완료로 적고 본문을 비운다(이미 확인된 글이어도 true).
 * 처음 확인한 것이면 세션을 다시 일하는 중(run)으로 바꿔 내보낸다. → 그런 글이 없으면 false(404).
 */
export async function ackMessage(deps: DeliverDeps, machineId: string, sessionId: string, messageId: string): Promise<boolean> {
  const now = deps.now();
  const result = await deps.sql.begin(async (tx): Promise<'unknown' | 'again' | 'first'> => {
    const [m] = await tx<{ delivered_at: Date | null; handed_at: Date | null }[]>`
      SELECT delivered_at, handed_at FROM session_messages
      WHERE id = ${messageId} AND session_id = ${sessionId} AND machine_id = ${machineId} FOR UPDATE`;
    if (!m || (!m.handed_at && !m.delivered_at)) return 'unknown';
    if (m.delivered_at) return 'again';
    await tx`UPDATE session_messages SET delivered_at = ${now}, text = '' WHERE id = ${messageId}`;
    await tx`
      UPDATE sessions SET status = 'run', last_event_at = GREATEST(last_event_at, ${now})
      WHERE id = ${sessionId} AND status = 'done'`;
    return 'first';
  });
  if (result === 'unknown') return false;
  if (result === 'first') await publishSessions(deps, [sessionId]);
  return true;
}
