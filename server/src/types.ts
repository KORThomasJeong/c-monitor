// 서버 안에서 함께 쓰는 타입.
import type postgres from 'postgres';
import type { StreamMessage } from '@c-monitor/shared';

/** 일반 연결과 트랜잭션 연결 둘 다 받는 쿼리 실행기. */
export type Q = postgres.ISql<{}>;

export type Config = {
  publicUrl: string;
  adminEmails: string[];
  sessionSecret: string;
  googleClientId: string;
  googleClientSecret: string;
};

export type GoogleClient = {
  authUrl(state: string, codeVerifier: string): string;
  exchange(code: string, codeVerifier: string): Promise<{ email: string; name: string | null }>;
};

export type Bus = {
  publish(userId: string, msg: StreamMessage): void;
  subscribe(userId: string, fn: (msg: StreamMessage) => void): () => void;
};

export type Deps = {
  sql: postgres.Sql;
  config: Config;
  bus: Bus;
  google: GoogleClient;
  now: () => Date;
  /** SSE 핑 간격(ms). 기본 15초. */
  pingMs?: number;
  /** 웹 빌드 폴더. 있으면 정적 서빙 + SPA 폴백. */
  webDist?: string;
};

export type User = {
  id: string;
  email: string;
  name: string | null;
  role: 'admin' | 'user';
  status: 'pending' | 'active' | 'suspended';
};

export type Machine = {
  id: string;
  userId: string;
  name: string;
  os: string;
  pluginVersion: string;
  lastSeenAt: Date | null;
};

/** Hono 컨텍스트 변수. */
export type Env = { Variables: { user: User; machine: Machine } };
