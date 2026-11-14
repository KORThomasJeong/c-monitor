// Hono 앱 조립. 의존성(deps)을 주입받아 테스트에서 가짜를 넣을 수 있다.
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { authRoutes } from './auth/routes';
import { deviceRoutes } from './device/routes';
import { ingestRoutes } from './ingest/routes';
import { queryRoutes } from './query/routes';
import { staticHandler } from './static';
import { streamRoutes } from './stream/routes';
import type { Deps, Env } from './types';

export function createApp(deps: Deps): Hono<Env> {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error('[server] 처리 중 오류:', err);
    return c.json({ error: 'internal' }, 500);
  });

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.route('/', authRoutes(deps));
  app.route('/', deviceRoutes(deps));
  app.route('/', ingestRoutes(deps));
  app.route('/', queryRoutes(deps));
  app.route('/', streamRoutes(deps));

  // 없는 API·auth 경로는 SPA로 떨어지지 않고 404.
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));
  app.all('/auth/*', (c) => c.json({ error: 'not_found' }, 404));

  if (deps.webDist) app.get('*', staticHandler(deps.webDist));
  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  return app;
}
