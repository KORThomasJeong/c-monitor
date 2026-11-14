// 서버 안에서 함께 쓰는 타입.
import type postgres from 'postgres';
import type { StreamMessage } from '@c-monitor/shared';
import type { TelegramHub } from './notify/hub';
import type { TelegramClient } from './notify/telegram';
import type { ReplyHub } from './reply/hub';

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
  /** 원격 답장의 대기자 목록(프로세스에 하나). */
  reply: ReplyHub;
  /** 텔레그램 봇의 상태·받기 루프·보내기 큐(프로세스에 하나). 봇이 없으면 모든 알림이 아무 일도 하지 않는다. */
  telegram: TelegramHub;
  /** 토큰으로 텔레그램 클라이언트를 만든다. 테스트에서는 가짜를 넣는다(실제 네트워크 금지). */
  telegramClient: (token: string) => TelegramClient;
  /** wait·inbox 요청 하나를 붙잡는 최대 시간(ms). 기본 REPLY_POLL_SECONDS초 — 테스트에서 줄인다. */
  replyPollMs?: number;
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
  remoteReply: boolean;
};

/** Hono 컨텍스트 변수. */
export type Env = { Variables: { user: User; machine: Machine } };
