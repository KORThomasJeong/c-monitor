// 기기 폐기. 웹(DELETE /api/machines/:id)과 터미널(POST /api/device/disconnect)이 같은 처리를 쓴다.
import { loadSnapshot } from '../query/views';
import type { Deps } from '../types';

/**
 * 그 사용자의 기기를 폐기한다(토큰이 더는 통하지 않는다). → 폐기했으면 true, 없거나 이미 폐기됐으면 false.
 * 목록에서 빠지는 변화는 스냅샷을 통째로 다시 보내 알린다.
 */
export async function revokeMachine(deps: Deps, userId: string, machineId: string): Promise<boolean> {
  const now = deps.now();
  const rows = await deps.sql`
    UPDATE machines SET revoked_at = ${now}
    WHERE id = ${machineId} AND user_id = ${userId} AND revoked_at IS NULL RETURNING id`;
  if (rows.length === 0) return false;
  deps.bus.publish(userId, { type: 'snapshot', ...(await loadSnapshot(deps.sql, userId, now)) });
  return true;
}
