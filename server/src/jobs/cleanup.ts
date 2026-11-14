// 보관 정리: 사용자별 보관 기간이 지난 대화·한도를 지우고, 만료된 부속 데이터도 치운다.
import type { Deps } from '../types';

const EVENT_ID_KEEP_DAYS = 7;

export type CleanupResult = { lines: number; limits: number; webSessions: number; deviceRequests: number; eventIds: number };

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

  return {
    lines: lines.count,
    limits: limits.count,
    webSessions: webSessions.count,
    deviceRequests: deviceRequests.count,
    eventIds: eventIds.count,
  };
}
