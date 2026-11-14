import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig, statusHome, claudeConfigDir } from '../lib/config.mjs';
import { readAccount } from '../lib/account.mjs';
import { MAX_BATCH_BYTES, QUEUE_LIMIT, enqueue, flush, queueSize, splitBatches } from '../lib/queue.mjs';
import { postJson } from '../lib/send.mjs';
import { closedPort, makeSandbox, startServer, useSandboxEnv } from './helpers.mjs';
import { writeFileSync } from 'node:fs';

let sb;
let restore;
beforeEach(() => { sb = makeSandbox(); restore = useSandboxEnv(sb); });
afterEach(() => { restore(); sb.cleanup(); });

const batch = (n) => ({ events: [{ id: `e-${n}` }], transcript: [] });
const queueFiles = () => readdirSync(join(sb.statusHome, 'queue')).filter((f) => f.endsWith('.json'));

describe('config·account', () => {
  it('환경변수로 위치를 바꿀 수 있고, 설정이 없으면 null', () => {
    expect(statusHome()).toBe(sb.statusHome);
    expect(claudeConfigDir()).toBe(sb.configDir);
    expect(loadConfig()).toBeNull();
    saveConfig({ server: 'http://x.test', token: 't', machineId: 'm', machineName: '집 PC', originalStatusLine: null });
    expect(loadConfig()).toMatchObject({ server: 'http://x.test', token: 't', machineName: '집 PC' });
  });

  it('깨진 설정 파일은 null로 본다', () => {
    writeFileSync(join(sb.statusHome, 'config.json'), '{깨짐');
    expect(loadConfig()).toBeNull();
  });

  it('클로드 계정 이메일을 .claude.json에서 읽고, 없으면 null', () => {
    expect(readAccount()).toBeNull();
    writeFileSync(join(sb.configDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'dev@example.com' } }));
    expect(readAccount()).toBe('dev@example.com');
    writeFileSync(join(sb.configDir, '.claude.json'), '{깨짐');
    expect(readAccount()).toBeNull();
  });
});

describe('queue', () => {
  it('넣은 순서대로 보내고, 보낸 것은 지운다', async () => {
    for (let i = 0; i < 5; i++) enqueue(batch(i));
    expect(queueSize()).toBe(5);
    const got = [];
    const sent = await flush(async (b) => { got.push(b.events[0].id); return true; });
    expect(sent).toBe(5);
    expect(got).toEqual(['e-0', 'e-1', 'e-2', 'e-3', 'e-4']);
    expect(queueSize()).toBe(0);
  });

  it('하나가 실패하면 거기서 멈추고 순서를 지킨다', async () => {
    for (let i = 0; i < 4; i++) enqueue(batch(i));
    const got = [];
    const sent = await flush(async (b) => { if (b.events[0].id === 'e-2') return false; got.push(b.events[0].id); return true; });
    expect(sent).toBe(2);
    expect(got).toEqual(['e-0', 'e-1']);
    expect(queueSize()).toBe(2);

    enqueue(batch(4));
    const rest = [];
    await flush(async (b) => { rest.push(b.events[0].id); return true; });
    expect(rest).toEqual(['e-2', 'e-3', 'e-4']);
  });

  it('보내는 함수가 예외를 던져도 실패로 다루고 큐를 지킨다', async () => {
    enqueue(batch(0));
    const sent = await flush(async () => { throw new Error('네트워크 오류'); });
    expect(sent).toBe(0);
    expect(queueSize()).toBe(1);
  });

  it("'drop'을 돌려주면 그 묶음은 버리고 다음으로 넘어간다", async () => {
    for (let i = 0; i < 3; i++) enqueue(batch(i));
    const got = [];
    const sent = await flush(async (b) => { if (b.events[0].id === 'e-1') return 'drop'; got.push(b.events[0].id); return true; });
    expect(sent).toBe(2);
    expect(got).toEqual(['e-0', 'e-2']);
    expect(queueSize()).toBe(0);
  });

  it('200개를 넘으면 가장 오래된 것부터 버린다', async () => {
    for (let i = 0; i < QUEUE_LIMIT + 5; i++) enqueue(batch(i));
    expect(QUEUE_LIMIT).toBe(200);
    expect(queueFiles().length).toBe(200);
    const got = [];
    await flush(async (b) => { got.push(b.events[0].id); return true; });
    expect(got[0]).toBe('e-5');
    expect(got.at(-1)).toBe('e-204');
  });

  it('깨진 큐 파일은 버리고 나머지를 보낸다', async () => {
    enqueue(batch(0));
    writeFileSync(join(sb.statusHome, 'queue', '0000000000000-000000-bad.json'), '{깨짐');
    const got = [];
    await flush(async (b) => { got.push(b.events[0].id); return true; });
    expect(got).toEqual(['e-0']);
    expect(queueSize()).toBe(0);
  });
});

describe('splitBatches', () => {
  const line = (bytes) => ({ role: 'assistant', at: '2026-11-14T08:00:00.000Z', text: 'x'.repeat(bytes) });

  it('작으면 묶음 하나, 대화가 없어도 이벤트는 보낸다', () => {
    const out = splitBatches({ events: [{ id: 'e' }], transcript: [{ sessionId: 's', seq: 3, lines: [line(10), line(10)] }] });
    expect(out).toHaveLength(1);
    expect(out[0].events).toEqual([{ id: 'e' }]);
    expect(out[0].transcript).toEqual([{ sessionId: 's', seq: 3, lines: [line(10), line(10)] }]);
    expect(splitBatches({ events: [{ id: 'e' }], transcript: [] })).toEqual([{ events: [{ id: 'e' }], transcript: [] }]);
    expect(splitBatches({ events: [], transcript: [{ sessionId: 's', seq: 0, lines: [] }] })).toEqual([]);
  });

  it('큰 대화는 512KB 이하 묶음 여러 개로 나누고 seq를 이어 붙인다', () => {
    const lines = Array.from({ length: 40 }, () => line(60_000)); // 약 2.4MB
    const machine = { name: '집 PC', os: 'win32', pluginVersion: '0.1.0' };
    const out = splitBatches({ events: [{ id: 'e' }], transcript: [{ sessionId: 's', seq: 100, lines }], limits: undefined });
    expect(out.length).toBeGreaterThan(4);
    let next = 100;
    let total = 0;
    for (const [i, b] of out.entries()) {
      expect(Buffer.byteLength(JSON.stringify({ machine, ...b }))).toBeLessThanOrEqual(MAX_BATCH_BYTES);
      expect(b.events).toEqual(i === 0 ? [{ id: 'e' }] : []); // 이벤트는 첫 묶음에만
      expect(b.transcript).toHaveLength(1);
      expect(b.transcript[0].seq).toBe(next);
      next += b.transcript[0].lines.length;
      total += b.transcript[0].lines.length;
    }
    expect(total).toBe(40);
  });
});

describe('postJson', () => {
  it('JSON을 Bearer 토큰과 함께 보내고 응답을 돌려준다', async () => {
    const server = await startServer(() => ({ status: 200, json: { accepted: 3 } }));
    try {
      const r = await postJson(`${server.url}/api/ingest`, { 안녕: 1 }, 'tok-1');
      expect(r).toEqual({ ok: true, status: 200, json: { accepted: 3 } });
      expect(server.requests[0].headers.authorization).toBe('Bearer tok-1');
      expect(server.requests[0].headers['content-type']).toContain('application/json');
      expect(server.requests[0].body).toEqual({ 안녕: 1 });
    } finally { await server.close(); }
  });

  it('오류 응답은 ok:false와 상태 코드', async () => {
    const server = await startServer(() => ({ status: 413, json: { error: 'too big' } }));
    try {
      const r = await postJson(`${server.url}/x`, {}, null);
      expect(r.ok).toBe(false);
      expect(r.status).toBe(413);
      expect(server.requests[0].headers.authorization).toBeUndefined();
    } finally { await server.close(); }
  });

  it('서버가 꺼져 있어도 예외를 던지지 않는다', async () => {
    const port = await closedPort();
    const r = await postJson(`http://127.0.0.1:${port}/x`, {}, 't');
    expect(r).toEqual({ ok: false, status: 0, json: null });
  });

  it('응답이 없으면 제한시간에 끊는다', async () => {
    const { createServer } = await import('node:http');
    const hang = createServer(() => { /* 대답하지 않음 */ });
    await new Promise((r) => hang.listen(0, '127.0.0.1', r));
    try {
      const t = Date.now();
      const r = await postJson(`http://127.0.0.1:${hang.address().port}/x`, {}, 't', 300);
      expect(r.ok).toBe(false);
      expect(Date.now() - t).toBeLessThan(1500);
    } finally { hang.closeAllConnections?.(); hang.close(); }
  });
});
