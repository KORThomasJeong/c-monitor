// 기기 폐기. 웹(DELETE /api/machines/:id)과 터미널(POST /api/device/disconnect)이 같은 처리를 쓴다.
import { republishSnapshots } from '../account/users';
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
  // 그 기기의 승인·질문과 아직 전달하지 않은 글은 더 쓸 수 없으니 지우고, 붙잡혀 있던 요청을 풀어 준다.
  const requests = await deps.sql<{ id: string }[]>`DELETE FROM reply_requests WHERE machine_id = ${machineId} RETURNING id`;
  await deps.sql`DELETE FROM session_messages WHERE machine_id = ${machineId}`;
  deps.reply.notifyRequests(requests.map((r) => r.id));
  deps.reply.dropInbox({ machineId });
  deps.bus.publish(userId, { type: 'snapshot', ...(await loadSnapshot(deps.sql, userId, now)) });
  // 그 컴퓨터의 세션을 사람 지정으로 공유받은 사람의 대시보드에서도 빠진다.
  const recipients = await deps.sql<{ id: string }[]>`
    SELECT DISTINCT sh.target_user_id AS id FROM shares sh JOIN sessions s ON s.id = sh.session_id
    WHERE s.machine_id = ${machineId} AND sh.target_user_id IS NOT NULL`;
  await republishSnapshots(deps, recipients.map((r) => r.id));
  return true;
}
