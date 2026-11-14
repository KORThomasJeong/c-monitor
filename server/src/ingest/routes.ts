// POST /api/ingest — 플러그인이 보내는 이벤트·대화·한도 묶음.
import { Hono } from 'hono';
import { IngestBatchSchema, MAX_BATCH_BYTES, type IngestResponse } from '@c-monitor/shared';
import { machineGuard, requireMachine } from '../auth/guard';
import type { Deps, Env } from '../types';
import { fail, parseJsonBody, readLimitedText } from '../util';
import { applyBatch } from './apply';

export function ingestRoutes(deps: Deps): Hono<Env> {
  const app = new Hono<Env>();

  app.post('/api/ingest', machineGuard(deps), async (c) => {
    const text = await readLimitedText(c.req.raw, MAX_BATCH_BYTES);
    if (text === null) throw fail(413, 'too_large');
    const parsed = IngestBatchSchema.safeParse(parseJsonBody(text));
    if (!parsed.success) throw fail(400, 'invalid_body');
    const res: IngestResponse = await applyBatch(deps, requireMachine(c), parsed.data);
    return c.json(res);
  });

  return app;
}
