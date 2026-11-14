import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/index';
import { makeTestDb, type TestDb } from './helpers';

let db: TestDb;
beforeAll(async () => { db = await makeTestDb(); });
afterAll(async () => { await db.drop(); });

describe('마이그레이션', () => {
  it('두 번 실행해도 오류가 없다', async () => {
    await migrate(db.sql);
    await migrate(db.sql);
  });

  it('테이블이 임시 스키마 안에만 만들어진다', async () => {
    const rows = await db.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = ${db.schema}`;
    const names = rows.map((r) => r.table_name).sort();
    for (const t of [
      'users', 'web_sessions', 'machines', 'device_requests', 'accounts', 'sessions',
      'transcript_lines', 'limits', 'settings', 'shares', 'event_ids',
    ]) {
      expect(names).toContain(t);
    }
    const [cur] = await db.sql<{ s: string }[]>`SELECT current_schema() AS s`;
    expect(cur!.s).toBe(db.schema);
  });

  it('세션에 카드용 활동 칸이 있다', async () => {
    const cols = await db.sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'sessions'`;
    const names = cols.map((c) => c.column_name);
    expect(names).toContain('activity_label');
    expect(names).toContain('activity_text');
  });
});
