// DB 연결과 마이그레이션.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

export function connect(databaseUrl: string): postgres.Sql {
  return postgres(databaseUrl, { max: 10, onnotice: () => {} });
}

/** schema.sql을 그대로 실행한다. 모든 문장이 IF NOT EXISTS라 여러 번 돌려도 된다. */
export async function migrate(sql: postgres.Sql): Promise<void> {
  const file = fileURLToPath(new URL('./schema.sql', import.meta.url));
  await sql.unsafe(readFileSync(file, 'utf8'));
}
