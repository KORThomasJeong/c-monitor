// 웹 답 기록(3차): 웹·텔레그램에서 답하거나 글을 보낼 때마다 한 줄씩 남기고 스트림으로 알린다.
import { randomUUID } from 'node:crypto';
import type { ReplyRecord, ReplyRequest } from '@c-monitor/shared';
import type { Deps, Q } from '../types';
import { head } from '../util';

const LABEL_MAX = 200;
/** GET /api/sessions/:id/replies 가 돌려주는 최대 개수(최근 것부터 세어 오래된 순으로). */
export const REPLY_RECORD_LIMIT = 200;

const BEHAVIOR_LABEL = { allow: '허용', allow_session: '이 세션 동안 허용', deny: '거부' } as const;

/** 사람이 읽을 한 줄: "허용", "이 세션 동안 허용", "거부"(사유가 있으면 "거부: 사유"), 고른 답, 보낸 글 앞 200자. */
export function replyLabel(body: ReplyRequest): string {
  if (body.type === 'permission') {
    const base = BEHAVIOR_LABEL[body.behavior];
    const msg = body.message?.replace(/\s+/g, ' ').trim();
    return msg ? head(`${base}: ${msg}`, LABEL_MAX) : base;
  }
  if (body.type === 'answer') return head(Object.values(body.answers).join(' / ').replace(/\s+/g, ' ').trim(), LABEL_MAX);
  return head(body.text.replace(/\s+/g, ' ').trim(), LABEL_MAX);
}

type RecordRow = { id: string; at: Date; source: ReplyRecord['source']; kind: ReplyRecord['kind']; label: string };
const toRecord = (r: RecordRow): ReplyRecord => ({ id: r.id, at: r.at.toISOString(), source: r.source, kind: r.kind, label: r.label });

/** 답 하나를 기록하고 세션 소유자에게 { type:'reply' } 를 내보낸다(공유받은 사람·관리자 열람 스트림도 소유자 채널에서 받는다). */
export async function recordReply(
  deps: Pick<Deps, 'sql' | 'bus' | 'now'>, ownerId: string, sessionId: string, source: ReplyRecord['source'], body: ReplyRequest,
): Promise<ReplyRecord> {
  const kind: ReplyRecord['kind'] = body.type;
  const [row] = await deps.sql<RecordRow[]>`
    INSERT INTO reply_records (id, session_id, user_id, at, source, kind, label)
    VALUES (${randomUUID()}, ${sessionId}, ${ownerId}, ${deps.now()}, ${source}, ${kind}, ${replyLabel(body)})
    RETURNING id, at, source, kind, label`;
  const reply = toRecord(row!);
  deps.bus.publish(ownerId, { type: 'reply', sessionId, reply });
  return reply;
}

/** 그 세션의 답 기록(최근 REPLY_RECORD_LIMIT개, 오래된 순). */
export async function loadReplies(sql: Q, sessionId: string): Promise<ReplyRecord[]> {
  const rows = await sql<RecordRow[]>`
    SELECT id, at, source, kind, label FROM reply_records WHERE session_id = ${sessionId}
    ORDER BY at DESC, id DESC LIMIT ${REPLY_RECORD_LIMIT}`;
  return rows.reverse().map(toRecord);
}
