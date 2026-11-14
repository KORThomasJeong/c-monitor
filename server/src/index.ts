// 실행 진입점: 마이그레이션 → 앱 시작 → 백그라운드 작업.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { createGoogleClient } from './auth/google';
import { loadConfig } from './config';
import { connect, migrate } from './db/index';
import { runCleanup } from './jobs/cleanup';
import { runLostCheck } from './jobs/lost';
import { createTelegramHub } from './notify/hub';
import { createPushHub, vapidKeys } from './notify/push';
import { startBotFromDb } from './notify/store';
import { createTelegramClient } from './notify/telegram';
import { createReplyHub } from './reply/hub';
import { sweepStaleRequests } from './reply/sweep';
import { createBus } from './stream/bus';
import type { Deps } from './types';

const LOST_CHECK_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
const CLEANUP_HOUR_KST = 4;

/** 다음 04:00(KST)까지 남은 시간(ms). */
function msUntilNextCleanup(now: Date): number {
  const kst = new Date(now.getTime() + 9 * 60 * 60_000);
  const next = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), CLEANUP_HOUR_KST);
  const diff = next - kst.getTime();
  return diff > 0 ? diff : diff + DAY_MS;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.adminEmails.length === 0) console.warn('[server] ADMIN_EMAILS가 비어 있어 가입을 승인할 관리자가 없습니다');

  const sql = connect(config.databaseUrl);
  await migrate(sql);

  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
  const deps: Deps = {
    sql,
    config,
    bus: createBus(),
    google: createGoogleClient(config),
    now: () => new Date(),
    reply: createReplyHub(),
    telegram: createTelegramHub(),
    telegramClient: (token) => createTelegramClient(token),
    push: createPushHub(),
    webDist: existsSync(webDist) ? webDist : undefined,
  };
  const app = createApp(deps);
  // 관리자가 넣어 둔 봇 토큰이 있으면 텔레그램 받기 루프를 시작한다.
  if (await startBotFromDb(deps)) console.log(`[telegram] 봇 @${deps.telegram.bot?.username} 받기 시작`);
  // 웹 푸시 VAPID 키: 없으면 이때 만들어 DB에 둔다.
  await vapidKeys(deps);

  const guard = (name: string, job: () => Promise<unknown>) => () => {
    job().catch((err) => console.error(`[jobs] ${name} 실패:`, err));
  };
  const lostTimer = setInterval(guard('끊김 판정', async () => {
    await runLostCheck(deps);
    // 플러그인이 오래 다시 묻지 않은 승인·질문도 같은 주기로 치운다.
    await sweepStaleRequests(deps);
  }), LOST_CHECK_MS);
  const cleanup = guard('보관 정리', async () => {
    console.log('[jobs] 보관 정리:', JSON.stringify(await runCleanup(deps)));
  });
  let cleanupTimer: NodeJS.Timeout = setTimeout(function tick() {
    cleanup();
    cleanupTimer = setTimeout(tick, DAY_MS);
  }, msUntilNextCleanup(new Date()));

  const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
    console.log(`[server] ${config.publicUrl} (포트 ${info.port}), 웹: ${deps.webDist ? '서빙' : '없음'}`);
  });

  const shutdown = () => {
    clearInterval(lostTimer);
    clearTimeout(cleanupTimer);
    server.close();
    void deps.telegram.stop();
    sql.end({ timeout: 5 }).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 6_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[server] 시작 실패:', err instanceof Error ? err.message : err);
  process.exit(1);
});
