// 보관 정리: 사용자별 보관 기간이 지난 대화·한도를 지우고, 만료된 부속 데이터도 치운다.
import type { Deps } from '../types';

const EVENT_ID_KEEP_DAYS = 7;
/** 지운 세션 표시를 남겨 두는 기간. 오래 열어 둔 세션의 종료 알림까지 막을 만큼 넉넉하게. */
const DELETED_KEEP_DAYS = 30;
/** 끝난 승인·질문과 웹에서 보낸 글을 남겨 두는 기간. */
const REPLY_KEEP_DAYS = 7;

export type CleanupResult = { lines: number; limits: number; webSessions: number; deviceRequests: number; eventIds: number; deletedSessions: number; replyRequests: number; sessionMessages: number };

export async function runCleanup(deps: Pick<Deps, 'sql' | 'now'>): Promise<CleanupResult> {
  const { sql } = deps;
  const now = deps.now();

  const lines = await sql`
    DELETE FROM transcript_lines t
    USING sessions s LEFT JOIN settings st ON st.user_id = s.user_id
    WHERE t.session_id = s.id
      AND t.at < ${now}::timestamptz - make_interval(days => COALESCE(st.keep_chat_days, 30))`;

  const limits = await sql`
    DELETE FROM limits l
    USING users u LEFT JOIN settings st ON st.user_id = u.id
    WHERE l.user_id = u.id
      AND l.at < ${now}::timestamptz - make_interval(days => COALESCE(st.keep_usage_days, 90))`;

  const webSessions = await sql`DELETE FROM web_sessions WHERE expires_at < ${now}`;
  const deviceRequests = await sql`DELETE FROM device_requests WHERE expires_at < ${now}`;
  const eventIds = await sql`
    DELETE FROM event_ids WHERE at < ${now}::timestamptz - make_interval(days => ${EVENT_ID_KEEP_DAYS})`;
  const deletedSessions = await sql`
    DELETE FROM deleted_sessions WHERE deleted_at < ${now}::timestamptz - make_interval(days => ${DELETED_KEEP_DAYS})`;

  // 끝난(answered·gone) 승인·질문. 아직 기다리는 것은 끊김 검사 주기의 정리(reply/sweep.ts)가 먼저 gone으로 만든다.
  const replyRequests = await sql`
    DELETE FROM reply_requests
    WHERE status <> 'pending'
      AND COALESCE(answered_at, polled_at) < ${now}::timestamptz - make_interval(days => ${REPLY_KEEP_DAYS})`;
  // 전달된 글(본문은 이미 비어 있다)과, 끝내 전달되지 못한 채 오래된 글.
  const sessionMessages = await sql`
    DELETE FROM session_messages
    WHERE COALESCE(delivered_at, created_at) < ${now}::timestamptz - make_interval(days => ${REPLY_KEEP_DAYS})`;

  return {
    lines: lines.count,
    limits: limits.count,
    webSessions: webSessions.count,
    deviceRequests: deviceRequests.count,
    eventIds: eventIds.count,
    deletedSessions: deletedSessions.count,
    replyRequests: replyRequests.count,
    sessionMessages: sessionMessages.count,
  };
}
