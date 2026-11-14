// 상태줄 래퍼: 원래 명령 출력은 바이트 그대로, 한도는 60초에 한 번만.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { osLabel } from '../lib/os.mjs';
import { BIN, closedPort, makeSandbox, runNode, startServer } from './helpers.mjs';

let sb;
let wrapper;
beforeEach(() => {
  sb = makeSandbox();
  // 연결 명령이 하는 것처럼 복사본을 따로 두고 실행한다(lib 없이도 돌아야 한다).
  mkdirSync(join(sb.statusHome, 'bin'), { recursive: true });
  wrapper = join(sb.statusHome, 'bin', 'statusline.mjs');
  copyFileSync(BIN('statusline.mjs'), wrapper);
  writeFileSync(join(sb.configDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'dev@example.com' } }));
});
afterEach(() => sb.cleanup());

// 원래 상태줄 흉내: 색상 코드·한글·CRLF가 섞인 바이트를 쓰고, 받은 stdin도 파일로 남긴다.
const ORIGINAL_BYTES = Buffer.from('\x1b[32m●\x1b[0m 한도 42%\r\n둘째 줄 │ ctx 12%\n', 'utf8');
function makeOriginal() {
  const script = join(sb.root, 'orig status.mjs'); // 경로에 공백
  const seen = join(sb.root, 'seen-stdin.bin');
  writeFileSync(script, [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    'const input = readFileSync(0);',
    `writeFileSync(${JSON.stringify(seen)}, input);`,
    `process.stdout.write(Buffer.from(${JSON.stringify(ORIGINAL_BYTES.toString('base64'))}, 'base64'));`,
  ].join('\n'));
  return { command: `node "${script.replace(/\\/g, '/')}"`, seen };
}
const connect = (server, originalStatusLine) => writeFileSync(join(sb.statusHome, 'config.json'), JSON.stringify({
  server, token: 'tok-1', machineId: 'm-1', machineName: '집 PC', pluginVersion: '0.1.0', originalStatusLine,
}));
const statusInput = (rate_limits) => JSON.stringify({
  session_id: 'sess-1', model: { id: 'claude-test-1', display_name: '테스트' }, workspace: { current_dir: 'C:\\work\\x' },
  ...(rate_limits ? { rate_limits } : {}),
});
const LIMITS = { five_hour: { used_percentage: 41.5, resets_at: 1794000000 }, seven_day: { used_percentage: 12, resets_at: 1794500000 } };
/** 컨텍스트·비용이 들어 있는 상태줄 입력 */
const statsInput = (extra = {}, sessionId = 'sess-1') => JSON.stringify({
  session_id: sessionId, model: { id: 'claude-test-1', display_name: '테스트' }, workspace: { current_dir: 'C:\\work\\x' }, ...extra,
});
const CTX = { context_window: { used_percentage: 37.26, context_window_size: 200000 }, cost: { total_cost_usd: 1.2345 } };
const statsFile = () => join(sb.statusHome, 'state', 'stats.json');
const readStats = () => JSON.parse(readFileSync(statsFile(), 'utf8'));
/** 세션 통계 마지막 전송 시각을 ms만큼 과거로 돌린다. */
const rewindStats = (ms = 61_000) => {
  const s = readStats();
  for (const e of Object.values(s.sessions)) e.sentAt -= ms;
  writeFileSync(statsFile(), JSON.stringify(s));
};
const statsOf = (server) => server.requests.filter((q) => q.body.sessionStats).map((q) => q.body.sessionStats);

describe('statusline.mjs', () => {
  it('원래 명령에 같은 stdin을 넘기고 그 출력을 바이트 그대로 전달한다', async () => {
    const server = await startServer();
    try {
      const orig = makeOriginal();
      connect(server.url, { type: 'command', command: orig.command, padding: 0 });
      const input = statusInput(LIMITS);
      const r = await runNode(wrapper, [], { env: sb.env, input });
      expect(r.code).toBe(0);
      expect(r.stdout.equals(ORIGINAL_BYTES)).toBe(true);
      expect(readFileSync(orig.seen).toString('utf8')).toBe(input);
    } finally { await server.close(); }
  });

  it('한도를 계약 모양으로 보내고, 60초 안에 다시 실행하면 보내지 않는다', async () => {
    const server = await startServer();
    try {
      connect(server.url, null);
      const a = await runNode(wrapper, [], { env: sb.env, input: statusInput(LIMITS) });
      expect(a.code).toBe(0);
      expect(a.stdout.length).toBe(0); // 원래 명령이 없으면 빈 출력
      const b = await runNode(wrapper, [], { env: sb.env, input: statusInput(LIMITS) });
      expect(b.code).toBe(0);

      expect(server.requests.length).toBe(1);
      const q = server.requests[0];
      expect(q.url).toBe('/api/ingest');
      expect(q.headers.authorization).toBe('Bearer tok-1');
      expect(q.body.events).toEqual([]);
      expect(q.body.transcript).toEqual([]);
      expect(q.body.machine).toMatchObject({ name: '집 PC', pluginVersion: '0.1.0' });
      const l = q.body.limits;
      expect(l).toMatchObject({
        account: 'dev@example.com', fiveHourPct: 41.5, fiveHourResetsAt: 1794000000, sevenDayPct: 12, sevenDayResetsAt: 1794500000,
      });
      expect(new Date(l.at).toISOString()).toBe(l.at);
    } finally { await server.close(); }
  });

  it('60초가 지났으면 다시 보낸다', async () => {
    const server = await startServer();
    try {
      connect(server.url, null);
      await runNode(wrapper, [], { env: sb.env, input: statusInput(LIMITS) });
      // 마지막 전송 시각을 61초 전으로 되돌린다.
      const stateFile = join(sb.statusHome, 'state', 'limits.json');
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      for (const k of Object.keys(state)) state[k] -= 61_000;
      writeFileSync(stateFile, JSON.stringify(state));
      await runNode(wrapper, [], { env: sb.env, input: statusInput(LIMITS) });
      expect(server.requests.length).toBe(2);
    } finally { await server.close(); }
  });

  it('창이 하나만 있으면 없는 쪽은 0과 null, 값은 0~100으로 맞춘다', async () => {
    const server = await startServer();
    try {
      connect(server.url, null);
      await runNode(wrapper, [], { env: sb.env, input: statusInput({ five_hour: { used_percentage: 130.2, resets_at: 1794000000.7 } }) });
      expect(server.requests[0].body.limits).toMatchObject({ fiveHourPct: 100, fiveHourResetsAt: 1794000001, sevenDayPct: 0, sevenDayResetsAt: null });
    } finally { await server.close(); }
  });

  it('rate_limits가 없으면 보내지 않는다', async () => {
    const server = await startServer();
    try {
      connect(server.url, null);
      await runNode(wrapper, [], { env: sb.env, input: statusInput(null) });
      expect(server.requests).toEqual([]);
    } finally { await server.close(); }
  });

  it('서버가 꺼져 있거나 연결 전이어도 원래 출력은 그대로 나온다', async () => {
    const orig = makeOriginal();
    connect(`http://127.0.0.1:${await closedPort()}`, { type: 'command', command: orig.command });
    const r = await runNode(wrapper, [], { env: sb.env, input: statusInput(LIMITS) });
    expect(r.code).toBe(0);
    expect(r.stdout.equals(ORIGINAL_BYTES)).toBe(true);

    // 설정 파일이 아예 없을 때
    const sb2 = makeSandbox();
    try {
      const r2 = await runNode(wrapper, [], { env: sb2.env, input: statusInput(LIMITS) });
      expect(r2.code).toBe(0);
      expect(r2.stdout.length).toBe(0);
    } finally { sb2.cleanup(); }
  });

  it('입력이 JSON이 아니어도 원래 명령은 실행한다', async () => {
    const orig = makeOriginal();
    connect('http://127.0.0.1:1', { type: 'command', command: orig.command });
    const r = await runNode(wrapper, [], { env: sb.env, input: '깨진 입력' });
    expect(r.stdout.equals(ORIGINAL_BYTES)).toBe(true);
  });

  it('운영체제 표기가 lib/os.mjs의 osLabel()과 같다(래퍼 안의 복제본 확인)', async () => {
    const server = await startServer();
    try {
      connect(server.url, null);
      await runNode(wrapper, [], { env: sb.env, input: statusInput(LIMITS) });
      expect(server.requests[0].body.machine.os).toBe(osLabel());
      expect(osLabel()).not.toMatch(/^(win32|darwin|linux) /);
    } finally { await server.close(); }
  });

  it('401(서버에서 연결 해제)이면 해제 표시를 남기고 큐를 비우며, 그 뒤로는 보내지 않되 원래 상태줄은 그대로 보인다', async () => {
    const server = await startServer(() => ({ status: 401, json: { error: 'unauthorized' } }));
    try {
      const orig = makeOriginal();
      connect(server.url, { type: 'command', command: orig.command });
      const queue = join(sb.statusHome, 'queue');
      mkdirSync(queue, { recursive: true });
      writeFileSync(join(queue, '0000000000001-000001-x.json'), JSON.stringify({ events: [], transcript: [] }));

      const a = await runNode(wrapper, [], { env: sb.env, input: statusInput(LIMITS) });
      expect(a.code).toBe(0);
      expect(a.stdout.equals(ORIGINAL_BYTES)).toBe(true);
      expect(server.requests.length).toBe(1);
      const cfg = JSON.parse(readFileSync(join(sb.statusHome, 'config.json'), 'utf8'));
      expect(new Date(cfg.revokedAt).toISOString()).toBe(cfg.revokedAt);
      expect(cfg).toMatchObject({ server: server.url, token: 'tok-1', machineName: '집 PC' });
      expect(cfg.originalStatusLine.command).toBe(orig.command);
      expect(readdirSync(queue).filter((f) => f.endsWith('.json'))).toEqual([]);

      // 60초 제한과 상관없이, 해제 표시가 있으면 보내지 않는다.
      const stateFile = join(sb.statusHome, 'state', 'limits.json');
      if (existsSync(stateFile)) writeFileSync(stateFile, '{}');
      const b = await runNode(wrapper, [], { env: sb.env, input: statusInput(LIMITS) });
      expect(b.code).toBe(0);
      expect(b.stdout.equals(ORIGINAL_BYTES)).toBe(true);
      expect(server.requests.length).toBe(1);
    } finally { await server.close(); }
  });

  it('설정이 없으면 세션 통계도 보내지 않는다', async () => {
    const r = await runNode(wrapper, [], { env: sb.env, input: statsInput({ context_window: { used_percentage: 10 } }) });
    expect(r.code).toBe(0);
    expect(existsSync(join(sb.statusHome, 'state', 'stats.json'))).toBe(false);
  });

  it('403(사용자 정지)은 해제로 보지 않는다', async () => {
    const server = await startServer(() => ({ status: 403, json: { error: 'suspended' } }));
    try {
      connect(server.url, null);
      await runNode(wrapper, [], { env: sb.env, input: statusInput(LIMITS) });
      expect(server.requests.length).toBe(1);
      expect(JSON.parse(readFileSync(join(sb.statusHome, 'config.json'), 'utf8')).revokedAt).toBeUndefined();
    } finally { await server.close(); }
  });
});

describe('statusline.mjs — 세션별 컨텍스트 %·비용', () => {
  it('used_percentage가 있으면 그 값을 소수 1자리로, 비용과 함께 한도와 같은 요청에 싣는다', async () => {
    const server = await startServer();
    try {
      connect(server.url, null);
      const r = await runNode(wrapper, [], { env: sb.env, input: statsInput({ ...CTX, rate_limits: LIMITS }) });
      expect(r.code).toBe(0);
      expect(server.requests).toHaveLength(1);
      const q = server.requests[0];
      expect(q.url).toBe('/api/ingest');
      expect(q.body.limits).toMatchObject({ account: 'dev@example.com', fiveHourPct: 41.5 });
      expect(q.body.sessionStats).toHaveLength(1);
      const s = q.body.sessionStats[0];
      expect(Object.keys(s).sort()).toEqual(['at', 'contextPct', 'costUsd', 'sessionId']);
      expect(s).toMatchObject({ sessionId: 'sess-1', contextPct: 37.3, costUsd: 1.2345 });
      expect(new Date(s.at).toISOString()).toBe(s.at);
    } finally { await server.close(); }
  });

  it('used_percentage가 없으면 current_usage의 입력+캐시 토큰 합 ÷ context_window_size로 계산한다(출력 토큰은 빼고)', async () => {
    const server = await startServer();
    try {
      connect(server.url, null);
      await runNode(wrapper, [], {
        env: sb.env,
        input: statsInput({
          context_window: {
            context_window_size: 200000,
            current_usage: { input_tokens: 10000, output_tokens: 99999, cache_creation_input_tokens: 5000, cache_read_input_tokens: 20000 },
          },
        }),
      });
      // 한도가 없어도 통계만 따로 보낸다.
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0].body.limits).toBeUndefined();
      expect(server.requests[0].body.events).toEqual([]);
      expect(server.requests[0].body.sessionStats[0]).toMatchObject({ sessionId: 'sess-1', contextPct: 17.5, costUsd: null });
    } finally { await server.close(); }
  });

  it('컨텍스트를 알 수 없으면 contextPct는 null, 비용도 없으면 통계를 싣지 않는다', async () => {
    const server = await startServer();
    try {
      connect(server.url, null);
      await runNode(wrapper, [], { env: sb.env, input: statsInput({ cost: { total_cost_usd: 0 } }, 'sess-a') });
      expect(statsOf(server)).toEqual([[expect.objectContaining({ sessionId: 'sess-a', contextPct: null, costUsd: 0 })]]);

      await runNode(wrapper, [], { env: sb.env, input: statsInput({ rate_limits: LIMITS }, 'sess-b') });
      expect(server.requests).toHaveLength(2);
      expect(server.requests[1].body.sessionStats).toBeUndefined();
      expect(server.requests[1].body.limits).toBeDefined();
    } finally { await server.close(); }
  });

  it('값이 0~100을 벗어나면 맞추고, 크기가 0이거나 토큰이 하나도 없으면 계산하지 않는다', async () => {
    const server = await startServer();
    try {
      connect(server.url, null);
      const cases = [
        [{ context_window: { used_percentage: 250 } }, 100],
        [{ context_window: { used_percentage: -3 } }, 0],
        [{ context_window: { context_window_size: 1000, current_usage: { input_tokens: 5000 } } }, 100],
        [{ context_window: { context_window_size: 0, current_usage: { input_tokens: 5000 } } }, null],
        [{ context_window: { context_window_size: 1000, current_usage: { output_tokens: 5 } } }, null],
      ];
      for (const [i, [extra, expected]] of cases.entries()) {
        await runNode(wrapper, [], { env: sb.env, input: statsInput({ ...extra, cost: { total_cost_usd: 0.5 } }, `sess-${i}`) });
      }
      expect(statsOf(server).map((s) => s[0].contextPct)).toEqual(cases.map(([, expected]) => expected));
    } finally { await server.close(); }
  });

  it('세션별로 60초에 한 번까지, 값이 바뀌었을 때만 보낸다', async () => {
    const server = await startServer();
    try {
      connect(server.url, null);
      const run = (extra, sid = 'sess-1') => runNode(wrapper, [], { env: sb.env, input: statsInput(extra, sid) });
      await run(CTX);
      expect(statsOf(server)).toHaveLength(1);

      // 60초 안: 값이 바뀌어도 보내지 않는다.
      await run({ ...CTX, cost: { total_cost_usd: 2 } });
      expect(statsOf(server)).toHaveLength(1);

      // 다른 세션은 따로 센다.
      await run(CTX, 'sess-2');
      expect(statsOf(server)).toHaveLength(2);

      // 60초가 지나도 마지막으로 보낸 값과 같으면 보내지 않는다.
      rewindStats();
      await run(CTX);
      expect(statsOf(server)).toHaveLength(2);

      // 60초가 지났고 값이 바뀌었으면 보낸다.
      await run({ ...CTX, cost: { total_cost_usd: 2 } });
      expect(statsOf(server)).toHaveLength(3);
      expect(statsOf(server)[2][0]).toMatchObject({ sessionId: 'sess-1', contextPct: 37.3, costUsd: 2 });

      // 상태 파일 모양
      const s = readStats();
      expect(s.disabledUntil).toBeNull();
      expect(Object.keys(s.sessions).sort()).toEqual(['sess-1', 'sess-2']);
      expect(s.sessions['sess-1']).toMatchObject({ contextPct: 37.3, costUsd: 2 });
    } finally { await server.close(); }
  });

  it('한도 60초 제한(계정별)과 통계 60초 제한(세션별)은 서로 따로 돈다', async () => {
    const server = await startServer();
    try {
      connect(server.url, null);
      await runNode(wrapper, [], { env: sb.env, input: statsInput({ ...CTX, rate_limits: LIMITS }, 'sess-1') });
      // 같은 계정의 다른 세션: 한도는 60초 안이라 빠지고 통계만 간다.
      await runNode(wrapper, [], { env: sb.env, input: statsInput({ ...CTX, rate_limits: LIMITS }, 'sess-2') });
      expect(server.requests).toHaveLength(2);
      expect(server.requests[0].body.limits).toBeDefined();
      expect(server.requests[1].body.limits).toBeUndefined();
      expect(server.requests[1].body.sessionStats[0].sessionId).toBe('sess-2');
    } finally { await server.close(); }
  });

  it('전송이 실패했으면 60초 뒤 같은 값이라도 다시 보낸다', async () => {
    let fail = true;
    const server = await startServer(() => (fail ? { status: 500, json: {} } : { status: 200, json: { accepted: 0 } }));
    try {
      connect(server.url, null);
      await runNode(wrapper, [], { env: sb.env, input: statsInput(CTX) });
      expect(readStats().sessions['sess-1'].ok).toBe(false);
      fail = false;
      rewindStats();
      await runNode(wrapper, [], { env: sb.env, input: statsInput(CTX) });
      expect(statsOf(server)).toHaveLength(2);
      expect(readStats().sessions['sess-1'].ok).toBeUndefined();
    } finally { await server.close(); }
  });

  it('sessionStats를 실은 요청이 400이면 한도만 다시 보내고, 24시간 동안은 통계를 싣지 않는다', async () => {
    // 옛 서버 흉내: sessionStats가 있으면 400
    const server = await startServer((req) => (req.body?.sessionStats ? { status: 400, json: { error: 'bad_request' } } : { status: 200, json: { accepted: 0 } }));
    try {
      const orig = makeOriginal();
      connect(server.url, { type: 'command', command: orig.command });
      const before = Date.now();
      const a = await runNode(wrapper, [], { env: sb.env, input: statsInput({ ...CTX, rate_limits: LIMITS }) });
      expect(a.code).toBe(0);
      expect(a.stdout.equals(ORIGINAL_BYTES)).toBe(true);
      expect(server.requests).toHaveLength(2);
      expect(server.requests[0].body.sessionStats).toBeDefined();
      expect(server.requests[1].body.sessionStats).toBeUndefined();
      expect(server.requests[1].body.limits).toEqual(server.requests[0].body.limits);

      const s = readStats();
      expect(s.disabledUntil).toBeGreaterThanOrEqual(before + 24 * 3600 * 1000);
      expect(s.disabledUntil).toBeLessThanOrEqual(Date.now() + 24 * 3600 * 1000);
      expect(s.sessions['sess-1']).toBeUndefined(); // 받지 않은 값은 기록에서 되돌린다
      // 400은 연결 해제가 아니다
      expect(JSON.parse(readFileSync(join(sb.statusHome, 'config.json'), 'utf8')).revokedAt).toBeUndefined();

      // 한도 60초가 지나 다시 실행: 한도만 가고 통계는 빠진다(값이 바뀌었어도).
      const limitsFile = join(sb.statusHome, 'state', 'limits.json');
      writeFileSync(limitsFile, '{}');
      await runNode(wrapper, [], { env: sb.env, input: statsInput({ ...CTX, cost: { total_cost_usd: 9 }, rate_limits: LIMITS }) });
      expect(server.requests).toHaveLength(3);
      expect(server.requests[2].body.sessionStats).toBeUndefined();
      expect(server.requests[2].body.limits).toBeDefined();

      // 한도도 없으면 아무것도 보내지 않는다.
      await runNode(wrapper, [], { env: sb.env, input: statsInput(CTX, 'sess-9') });
      expect(server.requests).toHaveLength(3);

      // 24시간이 지나면 다시 싣는다.
      writeFileSync(statsFile(), JSON.stringify({ ...readStats(), disabledUntil: Date.now() - 1 }));
      await runNode(wrapper, [], { env: sb.env, input: statsInput(CTX) });
      expect(server.requests).toHaveLength(4);
      expect(server.requests[3].body.sessionStats[0].sessionId).toBe('sess-1');
    } finally { await server.close(); }
  });

  it('하루 넘게 보내지 않은 세션 항목은 상태 파일에서 지운다', async () => {
    const server = await startServer();
    try {
      connect(server.url, null);
      await runNode(wrapper, [], { env: sb.env, input: statsInput(CTX, 'old') });
      rewindStats(25 * 3600 * 1000);
      await runNode(wrapper, [], { env: sb.env, input: statsInput(CTX, 'new') });
      expect(Object.keys(readStats().sessions)).toEqual(['new']);
    } finally { await server.close(); }
  });

  it('필드가 없거나 모양이 이상해도 원래 출력은 바이트 그대로이고, 보내는 값은 계약 모양을 지킨다', async () => {
    const server = await startServer();
    try {
      const orig = makeOriginal();
      connect(server.url, { type: 'command', command: orig.command });
      const weird = [
        { context_window: 'x', cost: 'free' },
        { context_window: [1, 2, 3], cost: [0.5] },
        { context_window: null, cost: null },
        { context_window: { used_percentage: '50', context_window_size: '200000', current_usage: 'many' } },
        { context_window: { current_usage: { input_tokens: 'a', cache_read_input_tokens: null } , context_window_size: 1000 } },
        { context_window: { used_percentage: { v: 1 } }, cost: { total_cost_usd: -1 } },
        { context_window: { context_window_size: -5, current_usage: { input_tokens: 10 } }, cost: { total_cost_usd: '1.0' } },
        { session_id: 123, context_window: { used_percentage: 10 } },
        { session_id: '', context_window: { used_percentage: 10 } },
        { session_id: { a: 1 }, cost: { total_cost_usd: 1 } },
      ];
      for (const [i, extra] of weird.entries()) {
        const input = JSON.stringify({ session_id: `w-${i}`, ...extra });
        const r = await runNode(wrapper, [], { env: sb.env, input });
        expect(r.code).toBe(0);
        expect(r.stdout.equals(ORIGINAL_BYTES)).toBe(true);
        expect(r.stderr).toBe('');
        expect(readFileSync(orig.seen).toString('utf8')).toBe(input);
      }
      // 계산할 수 없는 것은 모두 걸러졌다(아무것도 보낼 게 없음).
      expect(server.requests).toEqual([]);

      // 상태 파일이 깨져 있어도 원래 출력은 그대로이고 다시 보낸다.
      mkdirSync(join(sb.statusHome, 'state'), { recursive: true });
      writeFileSync(statsFile(), '{깨짐');
      const r = await runNode(wrapper, [], { env: sb.env, input: statsInput(CTX) });
      expect(r.stdout.equals(ORIGINAL_BYTES)).toBe(true);
      expect(statsOf(server)).toHaveLength(1);
      writeFileSync(statsFile(), JSON.stringify({ disabledUntil: 'x', sessions: [1, 2] }));
      const r2 = await runNode(wrapper, [], { env: sb.env, input: statsInput(CTX, 'sess-2') });
      expect(r2.stdout.equals(ORIGINAL_BYTES)).toBe(true);
      expect(statsOf(server)).toHaveLength(2);
    } finally { await server.close(); }
  });
});
