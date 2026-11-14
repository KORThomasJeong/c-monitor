// 보관 정리(매일): 탈퇴 7일이 지난 사용자 완전 삭제, 사용자별 보관 기간이 지난 대화·한도 지우기(0 = 지우지 않음),
// 저장 용량 한도를 넘은 사용자의 오래된 대화 줄 지우기(+알림), 만료된 부속 데이터 치우기.
import { trimToQuota } from '../account/storage';
import { purgeExpiredUsers } from '../account/users';
import { notifyTrim } from '../notify/notify';
import type { Deps } from '../types';

const EVENT_ID_KEEP_DAYS = 7;
/** 지운 세션 표시를 남겨 두는 기간. 오래 열어 둔 세션의 종료 알림까지 막을 만큼 넉넉하게. */
const DELETED_KEEP_DAYS = 30;
/** 끝난 승인·질문과 웹에서 보낸 글을 남겨 두는 기간. */
const REPLY_KEEP_DAYS = 7;
/** 텔레그램 알림 메시지 ↔ 세션 기록(답장·버튼용)을 남겨 두는 기간. */
const TELEGRAM_MESSAGE_KEEP_DAYS = 7;
/** 한도 알림 기록(텔레그램·웹 푸시). 주간 창(7일)보다 넉넉하게 남겨 같은 창에 다시 보내지 않게 한다. */
const LIMIT_ALERT_KEEP_DAYS = 30;

export type CleanupResult = {
  lines: number; limits: number; webSessions: number; deviceRequests: number; eventIds: number; deletedSessions: number;
  replyRequests: number; sessionMessages: number; telegramMessages: number; telegramCodes: number; limitAlerts: number;
  /** 3차 */
  purgedUsers: number; replyRecords: number; shares: number; pushSent: number;
  /** 용량 한도로 지운 대화 줄 수(모든 사용자 합) */
  trimmedLines: number;
};

export async function runCleanup(
  deps: Pick<Deps, 'sql' | 'now' | 'bus' | 'reply' | 'config' | 'telegram' | 'push'>,
): Promise<CleanupResult> {
  const { sql } = deps;
  const now = deps.now();

  // 탈퇴하고 삭제 예정 시각이 지난 사용자부터 지운다(그 사용자의 대화를 따로 정리할 필요가 없다).
  const purgedUsers = await purgeExpiredUsers(deps);

  // 보관 기간 0 = 지우지 않음.
  const lines = await sql`
    DELETE FROM transcript_lines t
    USING sessions s LEFT JOIN settings st ON st.user_id = s.user_id
    WHERE t.session_id = s.id
      AND COALESCE(st.keep_chat_days, 30) > 0
      AND t.at < ${now}::timestamptz - make_interval(days => COALESCE(st.keep_chat_days, 30))`;
  // 웹 답 기록은 대화와 같은 기간을 따른다.
  const replyRecords = await sql`
    DELETE FROM reply_records r
    USING users u LEFT JOIN settings st ON st.user_id = u.id
    WHERE r.user_id = u.id
      AND COALESCE(st.keep_chat_days, 30) > 0
      AND r.at < ${now}::timestamptz - make_interval(days => COALESCE(st.keep_chat_days, 30))`;

  const limits = await sql`
    DELETE FROM limits l
    USING users u LEFT JOIN settings st ON st.user_id = u.id
    WHERE l.user_id = u.id
      AND COALESCE(st.keep_usage_days, 90) > 0
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

  const telegramMessages = await sql`
    DELETE FROM telegram_messages WHERE created_at < ${now}::timestamptz - make_interval(days => ${TELEGRAM_MESSAGE_KEEP_DAYS})`;
  const telegramCodes = await sql`DELETE FROM telegram_link_codes WHERE expires_at < ${now}`;
  const limitAlerts = await sql`
    DELETE FROM limit_alerts WHERE created_at < ${now}::timestamptz - make_interval(days => ${LIMIT_ALERT_KEEP_DAYS})`;
  const pushSent = await sql`
    DELETE FROM push_sent WHERE created_at < ${now}::timestamptz - make_interval(days => ${LIMIT_ALERT_KEEP_DAYS})`;
  // 만료된 공유 링크(이미 404를 내지만 목록·표에서 치운다).
  const shares = await sql`DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at < ${now}`;

  // 마지막으로 용량 한도: 보관 기간 정리로 줄어든 뒤에도 넘는 사용자만 지우고 알린다.
  const trimmed = await trimToQuota(sql, now);
  for (const t of trimmed) notifyTrim(deps, t.userId, { lines: t.lines, quotaMb: t.quotaMb });

  return {
    lines: lines.count,
    limits: limits.count,
    webSessions: webSessions.count,
    deviceRequests: deviceRequests.count,
    eventIds: eventIds.count,
    deletedSessions: deletedSessions.count,
    replyRequests: replyRequests.count,
    sessionMessages: sessionMessages.count,
    telegramMessages: telegramMessages.count,
    telegramCodes: telegramCodes.count,
    limitAlerts: limitAlerts.count,
    purgedUsers,
    replyRecords: replyRecords.count,
    shares: shares.count,
    pushSent: pushSent.count,
    trimmedLines: trimmed.reduce((n, t) => n + t.lines, 0),
  };
}
