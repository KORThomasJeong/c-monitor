// 연결 명령: 기기 연결 흐름과 settings.json 수정(모두 임시 폴더에서).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { osLabel } from '../lib/os.mjs';
import { BIN, PLUGIN_ROOT, makeSandbox, runNode, startServer } from './helpers.mjs';

const CONNECT = BIN('connect.mjs');

let sb;
beforeEach(() => { sb = makeSandbox(); });
afterEach(() => sb.cleanup());

const settingsPath = () => join(sb.configDir, 'settings.json');
const readSettings = () => JSON.parse(readFileSync(settingsPath(), 'utf8'));
const readConfig = () => JSON.parse(readFileSync(join(sb.statusHome, 'config.json'), 'utf8'));
const run = (...args) => runNode(CONNECT, args, { env: sb.env });
const pendingPath = () => join(sb.statusHome, 'pending.json');

/** 가짜 서버: start → poll 202 한 번 → 200 */
function deviceServer({ outcome = 'approve', disconnect = 200 } = {}) {
  let polls = 0;
  return startServer((req) => {
    if (req.url === '/api/device/disconnect') return { status: disconnect, json: disconnect === 200 ? { ok: true } : { error: 'x' } };
    if (req.url === '/api/device/start') {
      return { status: 200, json: { deviceCode: 'dev-code-1', userCode: 'K7QM-2XPA', verifyUrl: 'http://x.test/connect', interval: 0.05, expiresIn: 5 } };
    }
    if (req.url === '/api/device/poll') {
      polls += 1;
      if (polls < 2) return { status: 202, json: {} };
      if (outcome === 'deny') return { status: 410, json: {} };
      return { status: 200, json: { token: 'tok-secret-1', machineId: 'm-1', machineName: '집 PC' } };
    }
    return { status: 404, json: {} };
  });
}

const ORIGINAL = { type: 'command', command: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\hud.js"', padding: 0 };

describe('connect.mjs', () => {
  it('서버 주소로 연결하고 설정을 저장하며 상태줄을 감싼다', async () => {
    const server = await deviceServer();
    try {
      writeFileSync(settingsPath(), JSON.stringify({ model: 'opus', statusLine: ORIGINAL, permissions: { allow: ['Bash(ls:*)'] } }, null, 2));
      const r = await run(server.url + '/');
      const out = r.stdout.toString('utf8');
      expect(r.code).toBe(0);
      expect(out).toContain('http://x.test/connect');
      expect(out).toContain('K7QM-2XPA');
      expect(out).toContain('집 PC');
      expect(out).not.toContain('tok-secret-1'); // 토큰은 화면에 찍지 않는다

      const start = server.requests[0];
      expect(start.url).toBe('/api/device/start');
      expect(typeof start.body.machineName).toBe('string');
      expect(start.body.machineName.length).toBeGreaterThan(0);
      expect(start.body.os).toBe(osLabel()); // 훅·상태줄 래퍼가 보내는 것과 같은 표기
      const version = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
      expect(start.body.pluginVersion).toBe(version);
      expect(server.requests.filter((q) => q.url === '/api/device/poll').every((q) => q.body.deviceCode === 'dev-code-1')).toBe(true);

      const cfg = readConfig();
      expect(cfg).toMatchObject({ server: server.url, token: 'tok-secret-1', machineId: 'm-1', machineName: '집 PC', originalStatusLine: ORIGINAL });

      const s = readSettings();
      expect(s.model).toBe('opus');
      expect(s.permissions).toEqual({ allow: ['Bash(ls:*)'] });
      expect(s.statusLine.type).toBe('command');
      const copy = join(sb.statusHome, 'bin', 'statusline.mjs');
      expect(s.statusLine.command).toBe(`node "${copy.replace(/\\/g, '/')}"`);
      expect(readFileSync(copy, 'utf8')).toBe(readFileSync(BIN('statusline.mjs'), 'utf8'));
      // 고치기 전 내용이 백업으로 남는다.
      expect(JSON.parse(readFileSync(settingsPath() + '.c-monitor.bak', 'utf8')).statusLine).toEqual(ORIGINAL);
    } finally { await server.close(); }
  });

  it('두 번 연결해도 한 번만 감싸고, --disconnect로 원래대로 돌아간다', async () => {
    const server = await deviceServer();
    try {
      writeFileSync(settingsPath(), JSON.stringify({ model: 'opus', statusLine: ORIGINAL }, null, 2));
      expect((await run(server.url)).code).toBe(0);
      const wrapped = readSettings().statusLine;
      expect((await run(server.url)).code).toBe(0);
      expect(readSettings().statusLine).toEqual(wrapped);
      expect(readConfig().originalStatusLine).toEqual(ORIGINAL); // 래퍼를 원래 값으로 착각하지 않는다

      const st = await run('--status');
      expect(st.code).toBe(0);
      const text = st.stdout.toString('utf8');
      expect(text).toContain(server.url);
      expect(text).toContain('집 PC');
      expect(text).toMatch(/0\s*개/);
      expect(text).not.toContain('tok-secret-1');

      const d = await run('--disconnect');
      expect(d.code).toBe(0);
      expect(readSettings()).toEqual({ model: 'opus', statusLine: ORIGINAL });
      expect(existsSync(join(sb.statusHome, 'config.json'))).toBe(false);
    } finally { await server.close(); }
  });

  it('settings.json이 없으면 래퍼만 등록하고, 해제하면 statusLine 키를 지운다', async () => {
    const server = await deviceServer();
    try {
      expect((await run(server.url)).code).toBe(0);
      expect(readSettings().statusLine.command).toContain('statusline.mjs');
      expect(readConfig().originalStatusLine).toBeNull();
      expect((await run('--disconnect')).code).toBe(0);
      expect(readSettings()).toEqual({});
    } finally { await server.close(); }
  });

  it('settings.json을 읽을 수 없으면 건드리지 않고 연결만 한다', async () => {
    const server = await deviceServer();
    try {
      const broken = '{ "model": "opus", // 주석이 있는 파일\n }';
      writeFileSync(settingsPath(), broken);
      const r = await run(server.url);
      expect(r.code).toBe(0);
      expect(readFileSync(settingsPath(), 'utf8')).toBe(broken);
      expect(readConfig().token).toBe('tok-secret-1');
      expect(r.stdout.toString('utf8')).toContain('settings.json');
    } finally { await server.close(); }
  });

  it('거부되거나 만료되면 실패로 끝나고 아무것도 바꾸지 않는다', async () => {
    const server = await deviceServer({ outcome: 'deny' });
    try {
      writeFileSync(settingsPath(), JSON.stringify({ statusLine: ORIGINAL }));
      const r = await run(server.url);
      expect(r.code).toBe(1);
      expect(r.stdout.toString('utf8') + r.stderr).toContain('거부되었거나 만료되었습니다');
      expect(existsSync(join(sb.statusHome, 'config.json'))).toBe(false);
      expect(readSettings()).toEqual({ statusLine: ORIGINAL });
    } finally { await server.close(); }
  });

  it('연결 전 --status·--disconnect, 인자 없음도 오류 없이 안내한다', async () => {
    const st = await run('--status');
    expect(st.code).toBe(0);
    expect(st.stdout.toString('utf8')).toContain('연결되어 있지 않습니다');
    expect((await run('--disconnect')).code).toBe(0);
    expect(existsSync(settingsPath())).toBe(false);
    const none = await run();
    expect(none.code).toBe(0);
    expect(none.stdout.toString('utf8')).toContain('연결되어 있지 않습니다');
  });

  it('서버에 닿지 않으면 한글로 알리고 실패로 끝난다', async () => {
    const r = await run('http://127.0.0.1:1');
    expect(r.code).toBe(1);
    expect(r.stdout.toString('utf8') + r.stderr).toContain('서버에 연결하지 못했습니다');
  });

  it('--disconnect는 로컬 설정을 지우기 전에 서버에 기기 토큰으로 해제를 알린다', async () => {
    const server = await deviceServer();
    try {
      expect((await run(server.url)).code).toBe(0);
      const d = await run('--disconnect');
      const out = d.stdout.toString('utf8');
      expect(d.code).toBe(0);
      const call = server.requests.find((q) => q.url === '/api/device/disconnect');
      expect(call.method).toBe('POST');
      expect(call.headers.authorization).toBe('Bearer tok-secret-1');
      expect(out).toContain('연결을 끊었습니다');
      expect(out).not.toContain('알리지 못했습니다');
      expect(out).not.toContain('tok-secret-1');
      expect(existsSync(join(sb.statusHome, 'config.json'))).toBe(false);
    } finally { await server.close(); }
  });

  it('서버에 닿지 않아도 로컬 해제는 끝까지 하고, 웹에서 해제하라고 알린다', async () => {
    writeFileSync(settingsPath(), JSON.stringify({ statusLine: ORIGINAL }));
    const server = await deviceServer();
    try {
      expect((await run(server.url)).code).toBe(0);
    } finally { await server.close(); }
    // 서버가 꺼진 뒤
    const d = await run('--disconnect');
    const out = d.stdout.toString('utf8');
    expect(d.code).toBe(0);
    expect(d.ms).toBeLessThan(5000);
    expect(out).toContain('서버에는 알리지 못했습니다. 웹의 설정 화면에서 이 컴퓨터를 해제해 주세요.');
    expect(existsSync(join(sb.statusHome, 'config.json'))).toBe(false);
    expect(readSettings()).toEqual({ statusLine: ORIGINAL });
  });

  it('서버가 오류로 답하면(5xx) 알리지 못한 것으로 안내하고, 이미 폐기된 토큰(401)이면 조용히 끝낸다', async () => {
    for (const [status, warned] of [[500, true], [401, false]]) {
      const server = await deviceServer({ disconnect: status });
      try {
        expect((await run(server.url)).code).toBe(0);
        const d = await run('--disconnect');
        expect(d.code).toBe(0);
        expect(d.stdout.toString('utf8').includes('서버에는 알리지 못했습니다')).toBe(warned);
        expect(existsSync(join(sb.statusHome, 'config.json'))).toBe(false);
      } finally { await server.close(); }
    }
  });

  it('서버가 연결을 해제한 상태면 --status가 알려 주고, 다시 연결하면 표시가 지워진다', async () => {
    const server = await deviceServer();
    try {
      expect((await run(server.url)).code).toBe(0);
      writeFileSync(join(sb.statusHome, 'config.json'), JSON.stringify({ ...readConfig(), revokedAt: '2026-11-14T03:00:00.000Z' }));

      const st = await run('--status');
      const text = st.stdout.toString('utf8');
      expect(st.code).toBe(0);
      expect(text).toContain('서버에서 연결이 해제되었습니다');
      expect(text).toContain('/c-monitor:connect');
      expect(text).not.toContain('● 연결되어 있습니다');
      expect(text).not.toContain('tok-secret-1');

      expect((await run(server.url)).code).toBe(0);
      expect(readConfig().revokedAt).toBeUndefined();
      expect((await run('--status')).stdout.toString('utf8')).toContain('● 연결되어 있습니다');
    } finally { await server.close(); }
  });

  it('서버가 이미 해제한 상태에서 --disconnect하면 서버를 부르지 않고 로컬만 정리한다', async () => {
    const server = await deviceServer();
    try {
      writeFileSync(join(sb.statusHome, 'config.json'), JSON.stringify({
        server: server.url, token: 'tok-old', machineId: 'm-1', machineName: 'pc-1',
        originalStatusLine: null, revokedAt: '2026-11-14T03:00:00.000Z',
      }));
      const d = await run('--disconnect');
      expect(d.code).toBe(0);
      expect(d.stdout.toString('utf8')).not.toContain('알리지 못했습니다');
      expect(server.requests).toEqual([]);
      expect(existsSync(join(sb.statusHome, 'config.json'))).toBe(false);
    } finally { await server.close(); }
  });

  it('한 번에 실행해도 브라우저를 열지 않았으면 링크를 직접 열라고 알린다(테스트 환경은 항상 열기를 끈다)', async () => {
    expect(sb.env.C_MONITOR_NO_OPEN).toBe('1');
    const server = await deviceServer();
    try {
      const r = await run(server.url);
      const out = r.stdout.toString('utf8');
      expect(r.code).toBe(0);
      expect(out).toContain('아래 링크를 직접 열어 주세요');
      expect(out).not.toContain('브라우저를 열었습니다');
      expect(existsSync(pendingPath())).toBe(false); // 한 번에 실행하면 이어 쓸 파일을 남기지 않는다
    } finally { await server.close(); }
  });
});

describe('connect.mjs — 두 단계 연결(--start / --wait)', () => {
  it('--start는 링크와 코드를 출력하고 바로 끝나며 pending.json을 남긴다', async () => {
    const server = await deviceServer();
    try {
      const r = await run(server.url + '/', '--start');
      const out = r.stdout.toString('utf8');
      expect(r.code).toBe(0);
      expect(r.ms).toBeLessThan(2500);
      expect(out).toContain('http://x.test/connect');
      expect(out).toContain('K7QM-2XPA');
      expect(out).toContain('아래 링크를 직접 열어 주세요');
      expect(out).not.toContain('브라우저를 열었습니다');
      expect(out).not.toContain('dev-code-1'); // 기기 코드는 화면에 찍지 않는다
      // 클로드코드는 도구 출력을 앞 몇 줄만 보여 주고 접는다. 링크와 코드는 맨 앞 두 줄에 둔다.
      const [l1, l2] = out.split('\n');
      expect(l1).toContain('http://x.test/connect');
      expect(l2).toContain('K7QM-2XPA');

      // 기다리지 않는다: poll은 한 번도 하지 않았다
      expect(server.requests.map((q) => q.url)).toEqual(['/api/device/start']);
      const pending = JSON.parse(readFileSync(pendingPath(), 'utf8'));
      expect(pending).toMatchObject({ server: server.url, deviceCode: 'dev-code-1', userCode: 'K7QM-2XPA', verifyUrl: 'http://x.test/connect', interval: 0.05 });
      expect(pending.expiresAt).toBeGreaterThan(Date.now());
      expect(pending.expiresAt).toBeLessThanOrEqual(Date.now() + 5000);
      // 아직 연결된 것은 아니다
      expect(existsSync(join(sb.statusHome, 'config.json'))).toBe(false);
      expect(existsSync(settingsPath())).toBe(false);
    } finally { await server.close(); }
  });

  it('옵션 순서가 달라도(--start가 앞, --no-open 포함) 같다', async () => {
    const server = await deviceServer();
    try {
      const r = await run('--start', '--no-open', server.url);
      expect(r.code).toBe(0);
      expect(JSON.parse(readFileSync(pendingPath(), 'utf8')).deviceCode).toBe('dev-code-1');
    } finally { await server.close(); }
  });

  it('--wait는 승인되면 설정을 저장하고 상태줄을 감싼 뒤 pending.json을 지운다', async () => {
    const server = await deviceServer();
    try {
      writeFileSync(settingsPath(), JSON.stringify({ model: 'opus', statusLine: ORIGINAL }, null, 2));
      expect((await run(server.url, '--start')).code).toBe(0);
      const w = await run('--wait');
      const out = w.stdout.toString('utf8');
      expect(w.code).toBe(0);
      expect(out).toContain('집 PC');
      expect(out).not.toContain('tok-secret-1');
      expect(server.requests.filter((q) => q.url === '/api/device/poll').every((q) => q.body.deviceCode === 'dev-code-1')).toBe(true);

      expect(readConfig()).toMatchObject({ server: server.url, token: 'tok-secret-1', machineId: 'm-1', machineName: '집 PC', originalStatusLine: ORIGINAL });
      expect(readSettings().statusLine.command).toContain('statusline.mjs');
      expect(existsSync(pendingPath())).toBe(false);

      const st = await run('--status');
      expect(st.stdout.toString('utf8')).toContain('● 연결되어 있습니다');
    } finally { await server.close(); }
  });

  it('--wait: 거부(410)면 실패를 알리고 pending.json을 지운다', async () => {
    const server = await deviceServer({ outcome: 'deny' });
    try {
      expect((await run(server.url, '--start')).code).toBe(0);
      const w = await run('--wait');
      expect(w.code).toBe(1);
      expect(w.stdout.toString('utf8')).toContain('거부되었거나 만료되었습니다');
      expect(existsSync(pendingPath())).toBe(false);
      expect(existsSync(join(sb.statusHome, 'config.json'))).toBe(false);
    } finally { await server.close(); }
  });

  it('--wait: 진행 중인 요청이 없으면 안내하고, 이미 만료된 요청은 서버를 부르지 않고 지운다', async () => {
    const none = await run('--wait');
    expect(none.code).toBe(1);
    expect(none.stdout.toString('utf8')).toContain('진행 중인 연결 요청이 없습니다. /c-monitor:connect <서버주소>부터 실행해 주세요.');

    const server = await deviceServer();
    try {
      writeFileSync(pendingPath(), JSON.stringify({
        server: server.url, deviceCode: 'dev-code-old', userCode: 'AAAA-BBBB', verifyUrl: 'http://x.test/connect',
        interval: 0.05, expiresAt: Date.now() - 1000,
      }));
      const w = await run('--wait');
      expect(w.code).toBe(1);
      expect(w.stdout.toString('utf8')).toContain('거부되었거나 만료되었습니다');
      expect(server.requests).toEqual([]);
      expect(existsSync(pendingPath())).toBe(false);
    } finally { await server.close(); }
  });

  it('--start를 다시 하면 새 요청으로 덮어쓰고, 서버에 닿지 않으면 pending.json을 만들지 않는다', async () => {
    let n = 0;
    const server = await startServer((req) => {
      if (req.url !== '/api/device/start') return { status: 404, json: {} };
      n += 1;
      return { status: 200, json: { deviceCode: `dev-code-${n}`, userCode: 'K7QM-2XPA', verifyUrl: 'http://x.test/connect', interval: 0.05, expiresIn: 5 } };
    });
    try {
      expect((await run(server.url, '--start')).code).toBe(0);
      expect((await run(server.url, '--start')).code).toBe(0);
      expect(JSON.parse(readFileSync(pendingPath(), 'utf8')).deviceCode).toBe('dev-code-2');
    } finally { await server.close(); }

    const sb2 = makeSandbox();
    try {
      const r = await runNode(CONNECT, ['http://127.0.0.1:1', '--start'], { env: sb2.env });
      expect(r.code).toBe(1);
      expect(r.stdout.toString('utf8')).toContain('서버에 연결하지 못했습니다');
      expect(existsSync(join(sb2.statusHome, 'pending.json'))).toBe(false);
    } finally { sb2.cleanup(); }
  });

  it('서버 주소 없이 --start만 주면 사용법을 알리고, --disconnect·--status는 --start가 붙어도 그대로 동작한다', async () => {
    const r = await run('--start');
    expect(r.code).toBe(1);
    expect(r.stdout.toString('utf8')).toContain('사용법');
    const st = await run('--status', '--start');
    expect(st.code).toBe(0);
    expect(st.stdout.toString('utf8')).toContain('연결되어 있지 않습니다');
    expect((await run('--disconnect', '--start')).code).toBe(0);
    expect(existsSync(pendingPath())).toBe(false);
  });
});
