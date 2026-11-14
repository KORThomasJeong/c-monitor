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
