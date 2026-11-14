// 컴퓨터별 원격 답장 스위치. 소유자(PATCH /api/machines/:id)와 관리자(PATCH /api/admin/machines/:id)가 같은 처리를 쓴다.
import type { MachineView } from '@c-monitor/shared';
import { loadMachineViews, publishSessions } from '../query/views';
import type { Deps } from '../types';

/** 스위치를 바꿀 때 다시 내보내는 세션 수의 상한. */
const MACHINE_SESSION_LIMIT = 500;

/**
 * 그 사용자의 (폐기되지 않은) 컴퓨터의 원격 답장 스위치를 바꾼다. 없으면 null.
 * 끄면 기다리던 승인·질문은 gone, 아직 전달하지 않은 글은 버린다(나중에 켰을 때 옛 글이 튀어나오지 않게).
 * 바뀐 컴퓨터와 그 컴퓨터 세션들(canReply·pending이 달라진다)을 소유자에게 다시 내보낸다.
 */
export async function setRemoteReply(
  deps: Pick<Deps, 'sql' | 'bus' | 'now' | 'reply'>, ownerId: string, machineId: string, remoteReply: boolean,
): Promise<MachineView | null> {
  const { sql } = deps;
  const rows = await sql`
    UPDATE machines SET remote_reply = ${remoteReply}
    WHERE id = ${machineId} AND user_id = ${ownerId} AND revoked_at IS NULL RETURNING id`;
  if (rows.length === 0) return null;

  if (!remoteReply) {
    const gone = await sql<{ id: string }[]>`
      UPDATE reply_requests SET status = 'gone' WHERE machine_id = ${machineId} AND status = 'pending' RETURNING id`;
    await sql`DELETE FROM session_messages WHERE machine_id = ${machineId} AND delivered_at IS NULL`;
    deps.reply.notifyRequests(gone.map((r) => r.id));
    deps.reply.dropInbox({ machineId });
  }

  const [view] = await loadMachineViews(sql, ownerId, deps.now(), { id: machineId });
  deps.bus.publish(ownerId, { type: 'machine', machine: view! });
  const sessions = await sql<{ id: string }[]>`
    SELECT id FROM sessions WHERE machine_id = ${machineId} AND status <> 'end'
    ORDER BY last_event_at DESC LIMIT ${MACHINE_SESSION_LIMIT}`;
  await publishSessions(deps, sessions.map((r) => r.id));
  return view!;
}
