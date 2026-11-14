// GET /api/stream — SSE. 접속 즉시 snapshot, 이후 그 사용자의 변경만, 주기적으로 `: ping`.
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { StreamMessage } from '@c-monitor/shared';
import { requireUser, userGuard } from '../auth/guard';
import { loadSnapshot } from '../query/views';
import type { Deps, Env } from '../types';

const PING_MS = 15_000;

export function streamRoutes(deps: Deps): Hono<Env> {
  const app = new Hono<Env>();

  app.get('/api/stream', userGuard(deps, 'active'), (c) => {
    const user = requireUser(c);
    c.header('Content-Type', 'text/event-stream; charset=utf-8');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('X-Accel-Buffering', 'no'); // 프록시(nginx) 버퍼링 끔

    return stream(c, async (s) => {
      let closed = false;
      const write = async (chunk: string) => {
        if (closed) return;
        try {
          await s.write(chunk);
        } catch {
          closed = true;
        }
      };
      const send = (msg: StreamMessage) => write(`data: ${JSON.stringify(msg)}\n\n`);

      // 스냅샷을 읽는 동안 생긴 변경을 놓치지 않도록 먼저 구독하고 쌓아 둔다.
      const pending: StreamMessage[] = [];
      let live = false;
      const unsubscribe = deps.bus.subscribe(user.id, (msg) => {
        if (live) void send(msg);
        else pending.push(msg);
      });
      const ping = setInterval(() => void write(': ping\n\n'), deps.pingMs ?? PING_MS);
      const aborted = new Promise<void>((resolve) => {
        s.onAbort(() => {
          closed = true;
          resolve();
        });
      });

      try {
        const snapshot = await loadSnapshot(deps.sql, user.id, deps.now());
        await send({ type: 'snapshot', ...snapshot });
        for (const msg of pending) await send(msg); // 보내는 사이 더 쌓인 것도 이어서 나간다
        live = true;
        await aborted;
      } finally {
        clearInterval(ping);
        unsubscribe();
      }
    });
  });

  return app;
}
