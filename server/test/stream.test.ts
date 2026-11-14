import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StreamMessage } from '@c-monitor/shared';
import { createBus } from '../src/stream/bus';
import { makeHarness, makeTestDb, sseReader, type TestDb } from './helpers';

let db: TestDb;
let h: ReturnType<typeof makeHarness>;
let a: { cookie: string; id: string; token: string; machineId: string };
let b: { cookie: string; id: string; token: string; machineId: string };

beforeAll(async () => {
  db = await makeTestDb();
  h = makeHarness(db, { pingMs: 50 });
  const ua = await h.activeUser('a@example.com');
  const ub = await h.activeUser('b@example.com');
  a = { ...ua, ...(await h.connect(ua.cookie, 'pc-a')) };
  b = { ...ub, ...(await h.connect(ub.cookie, 'pc-b')) };
  await h.ingest(a.token, h.batch([h.ev('s1', 'UserPromptSubmit', { prompt: 'A의 질문' })]));
});
afterAll(async () => { await db.drop(); });

describe('버스', () => {
  it('구독한 사용자의 메시지만 받고, 해지하면 더 받지 않는다', () => {
    const bus = createBus();
    const got: StreamMessage[] = [];
    const off = bus.subscribe('u1', (m) => got.push(m));
    const msg: StreamMessage = { type: 'log', sessionId: 's', lines: [] };
    bus.publish('u1', msg);
    bus.publish('u2', msg);
    expect(got).toHaveLength(1);
    off();
    bus.publish('u1', msg);
    expect(got).toHaveLength(1);
  });

  it('구독자 하나가 예외를 던져도 나머지는 받는다', () => {
    const bus = createBus();
    let n = 0;
    bus.subscribe('u1', () => { throw new Error('깨짐'); });
    bus.subscribe('u1', () => { n++; });
    bus.publish('u1', { type: 'log', sessionId: 's', lines: [] });
    expect(n).toBe(1);
  });
});

describe('SSE', () => {
  it('로그인이 필요하다', async () => {
    expect((await h.req('GET', '/api/stream')).status).toBe(401);
  });

  it('첫 메시지는 snapshot이고, 이후 내 변경만 받는다', async () => {
    const res = await h.req('GET', '/api/stream', { cookie: a.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const r = sseReader(res);
    try {
      const first = await r.nextMessage();
      expect(first.type).toBe('snapshot');
      expect(first.type === 'snapshot' && first.sessions.map((s) => s.id)).toEqual([`${a.machineId}:s1`]);
      expect(first.type === 'snapshot' && first.machines.map((m) => m.id)).toEqual([a.machineId]);

      // B의 변경이 먼저 일어나도 A의 스트림에는 오지 않는다
      await h.ingest(b.token, h.batch([h.ev('sb', 'UserPromptSubmit', { prompt: 'B의 비밀' })], {
        transcript: [{ sessionId: 'sb', seq: 0, lines: [h.line('B의 대화')] }],
      }));
      await h.ingest(a.token, h.batch([h.ev('s1', 'Stop', { last_assistant_message: '끝' })]));
      const next = await r.nextMessage();
      expect(next).toMatchObject({ type: 'session', session: { id: `${a.machineId}:s1`, status: 'done' } });
    } finally {
      await r.close();
    }
  });

  it('B의 스트림에는 B의 것만 온다', async () => {
    const r = sseReader(await h.req('GET', '/api/stream', { cookie: b.cookie }));
    try {
      const first = await r.nextMessage();
      expect(JSON.stringify(first)).not.toContain('A의');
      expect(first.type === 'snapshot' && first.sessions.every((s) => s.machineId === b.machineId)).toBe(true);
      await h.ingest(a.token, h.batch([h.ev('s1', 'UserPromptSubmit', { prompt: 'A의 두 번째' })]));
      await h.ingest(b.token, h.batch([h.ev('sb', 'Stop', {})]));
      const next = await r.nextMessage();
      expect(next).toMatchObject({ type: 'session', session: { id: `${b.machineId}:sb` } });
    } finally {
      await r.close();
    }
  });

  it('주기적으로 주석 줄 ping을 보낸다', async () => {
    const r = sseReader(await h.req('GET', '/api/stream', { cookie: a.cookie }));
    try {
      await r.nextMessage();
      expect(await r.next()).toBe(': ping');
    } finally {
      await r.close();
    }
  });

  it('연결을 끊으면 구독이 해지된다', async () => {
    let subs = 0;
    const inner = createBus();
    const hs = makeHarness(db, {
      bus: {
        publish: inner.publish,
        subscribe(userId, fn) {
          subs++;
          const off = inner.subscribe(userId, fn);
          return () => { subs--; off(); };
        },
      },
    });
    const r = sseReader(await hs.req('GET', '/api/stream', { cookie: a.cookie }));
    await r.nextMessage();
    expect(subs).toBe(1);
    await r.close();
    await new Promise((res) => setTimeout(res, 50));
    expect(subs).toBe(0);
  });
});
