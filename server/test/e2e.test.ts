// 끝에서 끝까지: 실제 플러그인 스크립트를 자식 프로세스로 돌려 실제 HTTP 서버에 붙인다.
// 연결 명령 → 웹 승인 → 훅 전송 → 조회 · 실시간 스트림 · 한도까지 한 번에 확인한다.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import type { DashboardSnapshot, LogResponse } from '@c-monitor/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeHarness, makeTestDb, sseReader, type TestDb } from './helpers';

const PLUGIN = fileURLToPath(new URL('../../plugin/', import.meta.url));
const SECRET = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0'.repeat(3);

let db: TestDb;
let h: ReturnType<typeof makeHarness>;
let server: ReturnType<typeof serve>;
let base: string;
let root: string;
let env: NodeJS.ProcessEnv;
let owner: { cookie: string; id: string };

/** 플러그인 스크립트를 실행하고 끝날 때까지 기다린다. */
function run(script: string, args: string[], input = ''): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(PLUGIN, 'bin', script), ...args], { env, windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(input);
  });
}

const hook = (payload: Record<string, unknown>) => run('hook.mjs', [], JSON.stringify(payload));

async function dashboard(cookie: string): Promise<DashboardSnapshot> {
  const res = await h.req('GET', '/api/sessions', { cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as DashboardSnapshot;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 8000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('기다리던 상태가 되지 않았습니다');
    await new Promise((r) => setTimeout(r, 150));
  }
}

beforeAll(async () => {
  db = await makeTestDb();
  // 플러그인이 실제 시각으로 이벤트를 만들므로 서버도 실제 시계를 쓴다.
  h = makeHarness(db, { now: () => new Date() });
  server = serve({ fetch: h.app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // 실제 사용자 설정을 건드리지 않게 전부 임시 폴더로 돌린다.
  root = mkdtempSync(join(tmpdir(), 'c-monitor-e2e-'));
  const configDir = join(root, 'claude');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(root, 'proj'), { recursive: true });
  writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'dev@example.com' } }));
  writeFileSync(
    join(configDir, 'settings.json'),
    JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: `node -e "process.stdout.write('HUD-OK')"` } }),
  );
  env = { ...process.env, C_MONITOR_HOME: join(root, 'cm'), CLAUDE_CONFIG_DIR: configDir, HOME: root, USERPROFILE: root };

  owner = await h.activeUser('owner@example.com');
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
  await db.drop();
});

describe('플러그인 ↔ 서버 전체 흐름', () => {
  it('연결 명령이 코드를 보여 주고, 웹에서 승인하면 연결과 상태줄 래퍼 설치가 끝난다', async () => {
    const child = spawn(process.execPath, [join(PLUGIN, 'bin', 'connect.mjs'), base], { env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.resume();
    const done = new Promise<number | null>((r) => child.on('close', r));

    const userCode = await waitFor(async () => out.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/)?.[0]);
    const approve = await h.req('POST', '/api/device/approve', { cookie: owner.cookie, body: { userCode } });
    expect(approve.status).toBe(200);
    expect(await done).toBe(0);

    const config = JSON.parse(readFileSync(join(root, 'cm', 'config.json'), 'utf8'));
    expect(config.server).toBe(base);
    expect(config.token).toBeTruthy();

    const settings = JSON.parse(readFileSync(join(root, 'claude', 'settings.json'), 'utf8'));
    expect(settings.model).toBe('opus');
    expect(settings.statusLine.command).toContain('statusline.mjs');
    expect(existsSync(join(root, 'cm', 'bin', 'statusline.mjs'))).toBe(true);
  }, 40_000);

  it('훅 이벤트와 대화가 서버에 반영되고 비밀은 가려져서 저장된다', async () => {
    const transcript = join(root, 'proj', 's-e2e.jsonl');
    const at = new Date().toISOString();
    writeFileSync(
      transcript,
      [
        { type: 'user', isSidechain: false, message: { role: 'user', content: `빌드해 줘. 키는 ${SECRET} 이야` }, uuid: 'u-1', timestamp: at },
        { type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: '빌드를 시작합니다.' }] }, uuid: 'a-1', timestamp: at },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
    const common = { session_id: 's-e2e', transcript_path: transcript, cwd: join(root, 'proj') };

    const r1 = await hook({ ...common, hook_event_name: 'UserPromptSubmit', prompt: '빌드해 줘' });
    expect(r1.code).toBe(0);
    expect(r1.stdout).toBe('');

    const snap = await dashboard(owner.cookie);
    expect(snap.machines).toHaveLength(1);
    expect(snap.sessions).toHaveLength(1);
    const s = snap.sessions[0]!;
    expect(s.status).toBe('run');
    expect(s.name).toBe('proj');
    expect(s.account).toBe('dev@example.com');
    expect(snap.accounts.map((a) => a.email)).toContain('dev@example.com');

    const logRes = await h.req('GET', `/api/sessions/${encodeURIComponent(s.id)}/log`, { cookie: owner.cookie });
    const { lines } = (await logRes.json()) as LogResponse;
    expect(lines.map((l) => l.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
    expect(lines[0]!.masked).toBeGreaterThanOrEqual(1);
    expect(lines[1]!.text).toBe('빌드를 시작합니다.');

    // 승인 요청 알림 → 기다림 + 아직 안 봄
    await hook({ ...common, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Bash 실행 승인이 필요합니다' });
    const waiting = (await dashboard(owner.cookie)).sessions[0]!;
    expect(waiting.status).toBe('wait');
    expect(waiting.seen).toBe(false);
  }, 40_000);

  it('다른 사용자에게는 이 세션이 보이지 않는다', async () => {
    const other = await h.activeUser('other@example.com');
    const snap = await dashboard(other.cookie);
    expect(snap.sessions).toHaveLength(0);
    expect(snap.machines).toHaveLength(0);
    expect(snap.accounts).toHaveLength(0);
  });

  it('실시간 스트림으로 상태 변화가 바로 온다', async () => {
    const res = await h.req('GET', '/api/stream', { cookie: owner.cookie });
    const stream = sseReader(res);
    expect((await stream.nextMessage()).type).toBe('snapshot');

    const r = await hook({ session_id: 's-e2e', transcript_path: join(root, 'proj', 's-e2e.jsonl'), cwd: join(root, 'proj'), hook_event_name: 'Stop', last_assistant_message: '빌드를 마쳤습니다.' });
    expect(r.code).toBe(0);

    let status: string | undefined;
    for (let i = 0; i < 10 && status !== 'done'; i++) {
      const msg = await stream.nextMessage();
      if (msg.type === 'session') status = msg.session.status;
    }
    await stream.close();
    expect(status).toBe('done');
  }, 30_000);

  it('상태줄 래퍼가 원래 출력을 그대로 보여 주고 한도를 서버로 보낸다', async () => {
    const wrapper = join(root, 'cm', 'bin', 'statusline.mjs');
    const input = JSON.stringify({
      session_id: 's-e2e',
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        seven_day: { used_percentage: 61, resets_at: Math.floor(Date.now() / 1000) + 86400 },
      },
    });
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [wrapper], { env, windowsHide: true });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += String(d); });
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', () => resolve(stdout));
      child.stdin.end(input);
    });
    expect(out).toBe('HUD-OK');

    const account = await waitFor(async () => {
      const a = (await dashboard(owner.cookie)).accounts.find((x) => x.email === 'dev@example.com');
      return a && a.fiveHourPct !== null ? a : undefined;
    });
    expect(account.fiveHourPct).toBe(42);
    expect(account.sevenDayPct).toBe(61);
  }, 30_000);
});
