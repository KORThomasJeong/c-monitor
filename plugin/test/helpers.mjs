// 테스트 공용 도구: 임시 폴더, 자식 프로세스 실행, 가짜 서버.
// 실제 ~/.claude, ~/.c-monitor 를 절대 건드리지 않도록 모든 위치를 임시 폴더로 돌린다.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = (name) => join(PLUGIN_ROOT, 'bin', name);

/** 임시 작업 폴더 하나를 만들고 그 안의 위치들과 자식 프로세스용 환경변수를 돌려준다. */
export function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'c-monitor-test-'));
  const statusHome = join(root, 'status-home');
  const configDir = join(root, 'claude-config');
  mkdirSync(statusHome, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const env = {
    ...process.env,
    C_MONITOR_HOME: statusHome,
    CLAUDE_CONFIG_DIR: configDir,
    // 혹시 기본 경로로 떨어져도 실제 홈을 건드리지 않게 홈도 임시 폴더로 바꾼다.
    HOME: root,
    USERPROFILE: root,
  };
  return { root, statusHome, configDir, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 현재 프로세스의 환경변수를 샌드박스로 돌린다(라이브러리를 직접 import하는 테스트용). 되돌리는 함수를 돌려준다. */
export function useSandboxEnv(sb) {
  const keys = ['C_MONITOR_HOME', 'CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) process.env[k] = sb.env[k];
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

/** node 스크립트를 자식 프로세스로 실행한다. stdout은 바이트 그대로 돌려준다. */
export function runNode(script, args = [], { env, input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => resolve({
      code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8'), ms: Date.now() - started,
    }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** 가짜 HTTP 서버. handler(req, bodyJson) → {status, json}. 받은 요청을 requests에 순서대로 쌓는다. */
export async function startServer(handler, port = 0) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body = null;
      try { body = JSON.parse(raw.toString('utf8')); } catch { /* 본문 없음 */ }
      const record = { method: req.method, url: req.url, headers: req.headers, body, bytes: raw.length };
      requests.push(record);
      const r = (handler && handler(record)) || { status: 200, json: { accepted: 0 } };
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json ?? {}));
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const actualPort = server.address().port;
  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

/** 지금 아무도 듣고 있지 않은 포트 번호를 하나 구한다(서버 꺼짐 흉내). */
export async function closedPort() {
  const s = await startServer();
  await s.close();
  return s.port;
}
