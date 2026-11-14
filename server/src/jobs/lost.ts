// 끊김 판정: 사용자별 lost_minutes보다 오래 이벤트가 없는 run 세션을 lost로 바꾼다.
import { notifySessionChanges } from '../notify/notify';
import { loadSessionViews } from '../query/views';
import type { Deps } from '../types';

export async function runLostCheck(deps: Pick<Deps, 'sql' | 'bus' | 'now' | 'config' | 'telegram' | 'push'>): Promise<number> {
  const now = deps.now();
  const rows = await deps.sql<{ id: string }[]>`
    UPDATE sessions s SET status = 'lost'
    FROM users u LEFT JOIN settings st ON st.user_id = u.id
    WHERE s.user_id = u.id AND s.status = 'run'
      AND s.last_event_at < ${now}::timestamptz - make_interval(mins => COALESCE(st.lost_minutes, 10))
    RETURNING s.id`;
  const views = await loadSessionViews(deps.sql, rows.map((r) => r.id));
  for (const { userId, session } of views) deps.bus.publish(userId, { type: 'session', session });
  notifySessionChanges(deps, rows.map((r) => ({ sessionId: r.id, from: 'run' as const, to: 'lost' as const })));
  return rows.length;
}
