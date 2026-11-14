// 환경변수에서 설정을 읽는다.
import type { Config } from './types';

export type EnvConfig = Config & { databaseUrl: string; port: number };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`환경변수 ${name}이(가) 필요합니다`);
    return v;
  };
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0) throw new Error('PORT가 올바르지 않습니다');
  return {
    databaseUrl: need('DATABASE_URL'),
    publicUrl: need('PUBLIC_URL').replace(/\/+$/, ''),
    googleClientId: need('GOOGLE_CLIENT_ID'),
    googleClientSecret: need('GOOGLE_CLIENT_SECRET'),
    sessionSecret: need('SESSION_SECRET'),
    adminEmails: parseAdminEmails(env.ADMIN_EMAILS),
    port,
  };
}

export function parseAdminEmails(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
