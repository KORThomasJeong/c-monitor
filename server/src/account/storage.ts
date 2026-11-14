// 저장 용량: 사용자별 사용량 계산, 한도를 넘으면 오래된 대화 줄부터 지우기, 관리자 화면의 DB·디스크 크기.
import { statfs } from 'node:fs/promises';
import type { AdminStorageView } from '@c-monitor/shared';
import type { Q } from '../types';

export const MB = 1024 * 1024;
/** 한도 기록 한 줄을 대략 이만큼으로 친다(바이트). */
export const LIMIT_ROW_BYTES = 64;
/** 용량 정리에서도 지우지 않는 최근 대화(시간). */
export const TRIM_KEEP_HOURS = 24;

/**
 * 사용자별 사용량(바이트): 대화 줄의 본문(text)·도구 입력(tool_input) 길이 합 + 한도 기록 수 × LIMIT_ROW_BYTES.
 * DB 색인·여유 공간은 넣지 않은 "내 데이터"의 크기다.
 */
export async function userBytes(sql: Q, userIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (userIds.length === 0) return out;
  const rows = await sql<{ id: string; chat: string | null; limits: number }[]>`
    SELECT u.id,
      (SELECT sum(octet_length(t.text) + COALESCE(octet_length(t.tool_input::text), 0))
         FROM transcript_lines t JOIN sessions s ON s.id = t.session_id WHERE s.user_id = u.id) AS chat,
      (SELECT count(*)::int FROM limits l WHERE l.user_id = u.id) AS limits
    FROM users u WHERE u.id IN ${sql(userIds)}`;
  for (const r of rows) out.set(r.id, Number(r.chat ?? 0) + r.limits * LIMIT_ROW_BYTES);
  return out;
}

export type TrimResult = { userId: string; lines: number; quotaMb: number };

/**
 * 한도(quota_mb > 0)를 넘은 사용자마다 넘친 만큼 오래된 대화 줄부터 지운다(최근 TRIM_KEEP_HOURS 시간 줄은 남긴다).
 * 한도 0(무제한)인 사용자는 건드리지 않는다. 지웠으면 trimmed_at을 적는다. → 지운 사용자별 결과
 */
export async function trimToQuota(sql: Q, now: Date): Promise<TrimResult[]> {
  const users = await sql<{ id: string; quota_mb: number }[]>`SELECT id, quota_mb FROM users WHERE quota_mb > 0`;
  if (users.length === 0) return [];
  const bytes = await userBytes(sql, users.map((u) => u.id));
  const cutoff = new Date(now.getTime() - TRIM_KEEP_HOURS * 60 * 60_000);
  const out: TrimResult[] = [];
  for (const u of users) {
    const excess = (bytes.get(u.id) ?? 0) - u.quota_mb * MB;
    if (excess <= 0) continue;
    // 오래된 줄부터 누적한 크기가 넘친 양에 닿을 때까지(그 줄 포함) 지운다.
    const deleted = await sql`
      WITH l AS (
        SELECT t.session_id, t.seq, t.at,
               octet_length(t.text) + COALESCE(octet_length(t.tool_input::text), 0) AS b
        FROM transcript_lines t JOIN sessions s ON s.id = t.session_id
        WHERE s.user_id = ${u.id} AND t.at < ${cutoff}
      ), r AS (
        SELECT session_id, seq, b, sum(b) OVER (ORDER BY at, session_id, seq ROWS UNBOUNDED PRECEDING) AS cum FROM l
      )
      DELETE FROM transcript_lines t USING r
      WHERE t.session_id = r.session_id AND t.seq = r.seq AND r.cum - r.b < ${excess}`;
    if (deleted.count === 0) continue;
    await sql`UPDATE users SET trimmed_at = ${now} WHERE id = ${u.id}`;
    out.push({ userId: u.id, lines: deleted.count, quotaMb: u.quota_mb });
  }
  return out;
}

/** 서버 디스크의 남은 공간(바이트). 알 수 없으면 null. */
export async function diskFreeBytes(path = process.cwd()): Promise<number | null> {
  try {
    const s = await statfs(path);
    const free = Number(s.bavail) * Number(s.bsize);
    return Number.isFinite(free) && free >= 0 ? free : null;
  } catch {
    return null;
  }
}

/** 관리자 › 저장 용량: DB 전체·대화·사용량(한도 기록)·기타 크기, 디스크 남은 공간, 사용자별 사용량. */
export async function adminStorage(sql: Q, diskFree: () => Promise<number | null> = diskFreeBytes): Promise<AdminStorageView> {
  const [size] = await sql<{ total: string; chat: string; usage: string }[]>`
    SELECT pg_database_size(current_database()) AS total,
           pg_total_relation_size('transcript_lines') AS chat,
           pg_total_relation_size('limits') AS usage`;
  const totalBytes = Number(size?.total ?? 0);
  const chatBytes = Number(size?.chat ?? 0);
  const usageBytes = Number(size?.usage ?? 0);
  const users = await sql<{ id: string; email: string; quota_mb: number }[]>`SELECT id, email, quota_mb FROM users ORDER BY email`;
  const bytes = await userBytes(sql, users.map((u) => u.id));
  return {
    totalBytes, chatBytes, usageBytes,
    otherBytes: Math.max(0, totalBytes - chatBytes - usageBytes),
    diskFreeBytes: await diskFree(),
    users: users
      .map((u) => ({ id: u.id, email: u.email, bytes: bytes.get(u.id) ?? 0, quotaMb: u.quota_mb }))
      .sort((a, b) => b.bytes - a.bytes || a.email.localeCompare(b.email)),
  };
}
