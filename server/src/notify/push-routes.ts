// 웹 푸시 API. 계약: shared/src/contract.ts "웹 푸시".
//   GET /api/push/key · GET /api/push/subscriptions · POST·DELETE /api/push/subscribe · POST /api/push/test
import { Hono } from 'hono';
import { z } from 'zod';
import { PushSubscribeSchema } from '@c-monitor/shared';
import { requireUser, userGuard } from '../auth/guard';
import type { Deps, Env } from '../types';
import { fail, readBody } from '../util';
import { pushText, sendToSubscription, vapidKeys } from './push';

const EndpointSchema = z.object({ endpoint: z.string().url().max(2000) });

export function pushRoutes(deps: Deps): Hono<Env> {
  const { sql } = deps;
  const app = new Hono<Env>();
  const active = userGuard(deps, 'active');

  app.get('/api/push/key', active, async (c) => c.json({ publicKey: (await vapidKeys(deps)).publicKey }));

  app.get('/api/push/subscriptions', active, async (c) => {
    const rows = await sql<{ endpoint: string; label: string | null; created_at: Date }[]>`
      SELECT endpoint, label, created_at FROM push_subscriptions WHERE user_id = ${requireUser(c).id} ORDER BY created_at`;
    return c.json({ subscriptions: rows.map((r) => ({ endpoint: r.endpoint, label: r.label, createdAt: r.created_at.toISOString() })) });
  });

  // 같은 endpoint는 덮어쓴다(같은 브라우저로 다른 사람이 로그인해 구독하면 그 사람 것으로 바뀐다).
  app.post('/api/push/subscribe', active, async (c) => {
    const user = requireUser(c);
    const body = await readBody(c, PushSubscribeSchema);
    await sql`
      INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, label, created_at)
      VALUES (${body.endpoint}, ${user.id}, ${body.keys.p256dh}, ${body.keys.auth}, ${body.label ?? null}, ${deps.now()})
      ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
        label = EXCLUDED.label, created_at = EXCLUDED.created_at`;
    return c.json({ ok: true });
  });

  app.delete('/api/push/subscribe', active, async (c) => {
    const { endpoint } = await readBody(c, EndpointSchema);
    await sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint} AND user_id = ${requireUser(c).id}`;
    return c.json({ ok: true });
  });

  // 시험 알림: 내 구독이 아니면 404. 푸시 서비스가 구독이 없어졌다고(404·410) 하면 지우고 404.
  app.post('/api/push/test', active, async (c) => {
    const user = requireUser(c);
    const { endpoint } = await readBody(c, EndpointSchema);
    const [sub] = await sql<{ p256dh: string; auth: string }[]>`
      SELECT p256dh, auth FROM push_subscriptions WHERE endpoint = ${endpoint} AND user_id = ${user.id}`;
    if (!sub) throw fail(404, 'not_found');
    const result = await sendToSubscription(deps, user.id, { endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, pushText.test());
    if (result === 'gone') throw fail(404, 'not_found');
    if (result === 'failed') throw fail(502, 'send_failed');
    return c.json({ ok: true });
  });

  return app;
}
