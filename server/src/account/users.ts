// 사용자 계정: 관리자 화면용 뷰, 탈퇴·복구, 완전 삭제.
import { WITHDRAW_DAYS, type AdminUserView } from '@c-monitor/shared';
import { toUser, type UserRow } from '../auth/session';
import { loadSnapshot } from '../query/views';
import type { Deps, Q } from '../types';
import { userBytes } from './storage';

const DAY_MS = 24 * 60 * 60_000;

export type FullUserRow = UserRow & {
  created_at: Date; last_login_at: Date | null; quota_mb: number; invited: boolean; machines: number;
};

/** 관리자 화면의 사용자 목록(ids를 주면 그 사용자만). 승인 대기·삭제 예정이 위로 온다. */
export async function loadAdminUsers(sql: Q, ids?: string[]): Promise<AdminUserView[]> {
  const rows = await sql<FullUserRow[]>`
    SELECT u.id, u.email, u.name, u.role, u.status, u.consented_at, u.delete_at, u.created_at, u.last_login_at, u.quota_mb, u.invited,
           (SELECT count(*)::int FROM machines m WHERE m.user_id = u.id AND m.revoked_at IS NULL) AS machines
    FROM users u
    ${ids ? sql`WHERE u.id IN ${sql(ids)}` : sql``}
    ORDER BY (u.status = 'pending') DESC, (u.delete_at IS NOT NULL) DESC, u.created_at DESC`;
  const bytes = await userBytes(sql, rows.map((r) => r.id));
  return rows.map((r) => ({
    ...toUser(r),
    createdAt: r.created_at.toISOString(),
    lastLoginAt: r.last_login_at ? r.last_login_at.toISOString() : null,
    quotaMb: r.quota_mb,
    bytes: bytes.get(r.id) ?? 0,
    machines: r.machines,
    invited: r.invited,
  }));
}

/** 그 사용자가 사람 지정으로 공유해 준 상대들(그들의 대시보드를 다시 보내야 할 때). */
async function shareRecipients(sql: Q, ownerId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT DISTINCT target_user_id AS id FROM shares WHERE owner_id = ${ownerId} AND target_user_id IS NOT NULL`;
  return rows.map((r) => r.id);
}

/** 받은 사람들의 대시보드를 통째로 다시 보낸다(공유받은 세션이 생기거나 빠졌을 때). */
export async function republishSnapshots(deps: Pick<Deps, 'sql' | 'bus' | 'now'>, userIds: Iterable<string>): Promise<void> {
  for (const id of new Set(userIds)) {
    deps.bus.publish(id, { type: 'snapshot', ...(await loadSnapshot(deps.sql, id, deps.now())) });
  }
}

/** 그 사용자의 기기에 붙잡혀 있던 승인·질문 대기와 글 대기자를 풀어 준다. */
async function releaseWaiters(deps: Pick<Deps, 'sql' | 'reply'>, userId: string): Promise<void> {
  const requests = await deps.sql<{ id: string }[]>`
    UPDATE reply_requests SET status = 'gone' WHERE user_id = ${userId} AND status = 'pending' RETURNING id`;
  deps.reply.notifyRequests(requests.map((r) => r.id));
  const machines = await deps.sql<{ id: string }[]>`SELECT id FROM machines WHERE user_id = ${userId}`;
  for (const m of machines) deps.reply.dropInbox({ machineId: m.id });
}

/**
 * 탈퇴: 삭제 예정 시각을 적는다(WITHDRAW_DAYS 뒤). 그때부터 로그인 API·기기 전송·공유 링크가 막힌다.
 * 기기 토큰은 폐기하지 않는다 — 복구하면 그대로 이어진다. → 이번에 탈퇴 처리했으면 true(이미 탈퇴 중이면 false).
 */
export async function withdrawUser(deps: Pick<Deps, 'sql' | 'bus' | 'now' | 'reply'>, userId: string): Promise<boolean> {
  const deleteAt = new Date(deps.now().getTime() + WITHDRAW_DAYS * DAY_MS);
  const rows = await deps.sql`UPDATE users SET delete_at = ${deleteAt} WHERE id = ${userId} AND delete_at IS NULL RETURNING id`;
  if (rows.length === 0) return false;
  await releaseWaiters(deps, userId);
  await republishSnapshots(deps, await shareRecipients(deps.sql, userId));
  return true;
}

/** 탈퇴 취소. 삭제 예정 시각 전에만 된다. → 'ok' | 'not_withdrawn' | 'expired' | 'not_found' */
export async function restoreUser(
  deps: Pick<Deps, 'sql' | 'bus' | 'now'>, userId: string, opts: { force?: boolean } = {},
): Promise<'ok' | 'not_withdrawn' | 'expired' | 'not_found'> {
  const [u] = await deps.sql<{ delete_at: Date | null }[]>`SELECT delete_at FROM users WHERE id = ${userId}`;
  if (!u) return 'not_found';
  if (!u.delete_at) return 'not_withdrawn';
  if (!opts.force && u.delete_at <= deps.now()) return 'expired';
  await deps.sql`UPDATE users SET delete_at = NULL WHERE id = ${userId}`;
  await republishSnapshots(deps, await shareRecipients(deps.sql, userId));
  return 'ok';
}

/**
 * 사용자를 완전히 지운다(대화·기기·설정·공유·알림 연결 모두 — FK CASCADE). → 지웠으면 true.
 * 붙잡혀 있던 요청을 풀고, 그 사용자가 공유해 준 상대의 대시보드를 다시 보낸다.
 */
export async function purgeUser(deps: Pick<Deps, 'sql' | 'bus' | 'now' | 'reply'>, userId: string): Promise<boolean> {
  const recipients = await shareRecipients(deps.sql, userId);
  const machines = await deps.sql<{ id: string }[]>`SELECT id FROM machines WHERE user_id = ${userId}`;
  const requests = await deps.sql<{ id: string }[]>`SELECT id FROM reply_requests WHERE user_id = ${userId}`;
  const rows = await deps.sql`DELETE FROM users WHERE id = ${userId} RETURNING id`;
  if (rows.length === 0) return false;
  deps.reply.notifyRequests(requests.map((r) => r.id));
  for (const m of machines) deps.reply.dropInbox({ machineId: m.id });
  await republishSnapshots(deps, recipients.filter((id) => id !== userId));
  return true;
}

/** 삭제 예정 시각이 지난 탈퇴 사용자를 모두 지운다(매일 정리). → 지운 수 */
export async function purgeExpiredUsers(deps: Pick<Deps, 'sql' | 'bus' | 'now' | 'reply'>): Promise<number> {
  const due = await deps.sql<{ id: string }[]>`
    SELECT id FROM users WHERE delete_at IS NOT NULL AND delete_at <= ${deps.now()}`;
  let n = 0;
  for (const u of due) if (await purgeUser(deps, u.id)) n++;
  return n;
}
