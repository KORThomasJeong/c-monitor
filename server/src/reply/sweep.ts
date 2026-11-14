// 오래 다시 묻지 않은 승인·질문을 치운다(계획의 동작 규칙 3-③). 끊김 검사와 같은 주기로 돈다.
import { REPLY_STALE_SECONDS } from '@c-monitor/shared';
import { publishSessions } from '../query/views';
import type { Deps } from '../types';

/**
 * 플러그인이 REPLY_STALE_SECONDS 넘게 wait를 다시 부르지 않은 요청을 gone으로 바꾼다.
 * (훅 프로세스가 죽었거나 터미널에서 먼저 답하고 뒤따른 이벤트가 오지 않은 경우)
 * → 치운 요청 수. 치운 세션은 소유자에게 다시 내보낸다.
 */
export async function sweepStaleRequests(deps: Pick<Deps, 'sql' | 'bus' | 'now' | 'reply'>): Promise<number> {
  const now = deps.now();
  const rows = await deps.sql<{ id: string; session_id: string }[]>`
    UPDATE reply_requests SET status = 'gone'
    WHERE status = 'pending' AND polled_at < ${now}::timestamptz - make_interval(secs => ${REPLY_STALE_SECONDS})
    RETURNING id, session_id`;
  if (rows.length === 0) return 0;
  deps.reply.notifyRequests(rows.map((r) => r.id));
  await publishSessions(deps, rows.map((r) => r.session_id));
  return rows.length;
}
