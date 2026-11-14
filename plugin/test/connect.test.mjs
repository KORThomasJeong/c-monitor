// 연결 명령: 기기 연결 흐름과 settings.json 수정(모두 임시 폴더에서).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BIN, PLUGIN_ROOT, makeSandbox, runNode, startServer } from './helpers.mjs';

const CONNECT = BIN('connect.mjs');

let sb;
beforeEach(() => { sb = makeSandbox(); });
afterEach(() => sb.cleanup());

const settingsPath = () => join(sb.configDir, 'settings.json');
const readSettings = () => JSON.parse(readFileSync(settingsPath(), 'utf8'));
const readConfig = () => JSON.parse(readFileSync(join(sb.statusHome, 'config.json'), 'utf8'));
const run = (...args) => runNode(CONNECT, args, { env: sb.env });

/** 가짜 서버: start → poll 202 한 번 → 200 */
function deviceServer({ outcome = 'approve' } = {}) {
  let polls = 0;
  return startServer((req) => {
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
      expect(typeof start.body.os).toBe('string');
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
});
