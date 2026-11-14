#!/usr/bin/env node
// 상태줄 래퍼. 연결 명령이 이 파일을 $C_MONITOR_HOME/bin/ 으로 복사해 settings.json의 statusLine으로 등록한다.
// 따로 복사돼 실행되므로 lib를 import하지 않는 자급형 파일이다.
// 하는 일: ① 상태줄 입력의 한도(rate_limits)를 60초에 한 번 서버로 보내고
//          ② 원래 상태줄 명령에 같은 입력을 넘겨 그 출력을 그대로 보여 준다.
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform, release } from 'node:os';
import { join } from 'node:path';

const SEND_EVERY_MS = 60_000;
const SEND_TIMEOUT_MS = 2000;

const home = process.env.C_MONITOR_HOME || join(homedir(), '.c-monitor');

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readStdin() {
  return new Promise((done) => {
    const chunks = [];
    const finish = () => done(Buffer.concat(chunks));
    const timer = setTimeout(finish, 1000);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => { clearTimeout(timer); finish(); });
    process.stdin.on('error', () => { clearTimeout(timer); finish(); });
  });
}

function readAccount() {
  const path = process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : join(homedir(), '.claude.json');
  const email = readJson(path)?.oauthAccount?.emailAddress;
  return typeof email === 'string' && email.length > 0 ? email.slice(0, 320) : null;
}

const pct = (v) => (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0);
const epoch = (v) => (Number.isFinite(v) ? Math.round(v) : null);

/**
 * JSON을 보낸다(결과는 쓰지 않는다). 전역 fetch 대신 node:http/https — Windows의 Node 26에서
 * fetch 뒤에 process.exit()을 부르면 프로세스가 비정상 종료하기 때문이다.
 */
function post(url, body, token) {
  return new Promise((done) => {
    let req = null;
    const stop = () => { try { req?.destroy(); } catch { /* 무시 */ } done(); };
    const timer = setTimeout(stop, SEND_TIMEOUT_MS);
    try {
      const target = new URL(url);
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      req = send(target, {
        method: 'POST',
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': payload.length, authorization: `Bearer ${token}` },
      }, (res) => {
        res.resume();
        res.on('end', () => { clearTimeout(timer); done(); });
        res.on('error', () => { clearTimeout(timer); done(); });
      });
      req.on('error', () => { clearTimeout(timer); done(); });
      req.end(payload);
    } catch {
      clearTimeout(timer);
      stop();
    }
  });
}

/** 한도를 서버로 보낸다. 60초 안에 이미 보냈으면 건너뛴다. 실패는 무시한다. */
async function sendLimits(cfg, input) {
  try {
    if (!cfg || typeof cfg.server !== 'string' || typeof cfg.token !== 'string') return;
    const limits = input?.rate_limits;
    if (!limits || typeof limits !== 'object') return;
    const five = limits.five_hour;
    const seven = limits.seven_day;
    if (!Number.isFinite(five?.used_percentage) && !Number.isFinite(seven?.used_percentage)) return;
    const account = readAccount();
    if (!account) return;

    // 계정별 마지막 전송 시각. 보내기 전에 먼저 적어서 여러 세션이 한꺼번에 보내지 않게 한다.
    const statePath = join(home, 'state', 'limits.json');
    const state = readJson(statePath) ?? {};
    const now = Date.now();
    if (Number.isFinite(state[account]) && now - state[account] < SEND_EVERY_MS && now >= state[account]) return;
    state[account] = now;
    mkdirSync(join(home, 'state'), { recursive: true });
    const tmp = `${statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, statePath);

    const body = {
      machine: {
        name: String(cfg.machineName || hostname() || 'unknown').slice(0, 100),
        os: `${platform()} ${release()}`.slice(0, 100),
        pluginVersion: String(cfg.pluginVersion || '0.0.0').slice(0, 40),
      },
      events: [],
      transcript: [],
      limits: {
        account,
        // 창이 하나만 있으면 없는 쪽은 0과 null
        fiveHourPct: pct(five?.used_percentage),
        fiveHourResetsAt: epoch(five?.resets_at),
        sevenDayPct: pct(seven?.used_percentage),
        sevenDayResetsAt: epoch(seven?.resets_at),
        at: new Date(now).toISOString(),
      },
    };
    await post(`${cfg.server.replace(/\/+$/, '')}/api/ingest`, body, cfg.token);
  } catch { /* 한도 전송 실패는 상태줄에 영향을 주지 않는다 */ }
}

/** 명령을 셸로 실행하고 stdin을 넘긴다. stdout·stderr는 그대로 흘려보낸다. → 종료 코드(실행 자체가 안 되면 null) */
function spawnShell(file, args, options, stdin) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(file, args, { ...options, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
    } catch {
      done(null);
      return;
    }
    child.on('error', () => done(null));
    child.on('close', (code) => done(code ?? 0));
    child.stdin.on('error', () => {}); // 원래 명령이 입력을 안 읽고 끝나도 괜찮다
    child.stdin.end(stdin);
  });
}

/** 원래 상태줄 명령을 실행한다. 없으면 아무것도 출력하지 않는다. */
async function runOriginal(cfg, stdin) {
  const command = cfg?.originalStatusLine?.command;
  if (typeof command !== 'string' || command.trim().length === 0) return 0;
  if (process.platform === 'win32') {
    // 클로드코드가 Git Bash로 우리를 실행했다면(SHELL·MSYSTEM이 있다) 원래 명령도 bash 문법일 수 있으니 bash로 돌린다.
    if (/(bash|zsh|sh)(\.exe)?$/i.test(process.env.SHELL || '') || process.env.MSYSTEM) {
      const code = await spawnShell('bash', ['-c', command], {}, stdin);
      if (code !== null) return code;
    }
    return (await spawnShell(command, [], { shell: true }, stdin)) ?? 0;
  }
  // bash·zsh·sh 계열이면 사용자의 셸로, 아니면(fish 등) 기본 /bin/sh로 실행한다.
  const userShell = /\/(bash|zsh|sh|dash|ksh)$/.test(process.env.SHELL || '') ? process.env.SHELL : true;
  return (await spawnShell(command, [], { shell: userShell }, stdin)) ?? 0;
}

async function main() {
  const stdin = await readStdin();
  const cfg = readJson(join(home, 'config.json'));
  let input = null;
  try {
    input = JSON.parse(stdin.toString('utf8'));
  } catch { /* 입력을 못 읽어도 원래 명령은 실행한다 */ }

  // 한도 전송과 원래 명령 실행을 동시에 진행한다(전송을 기다리느라 출력이 늦어지지 않게).
  const [code] = await Promise.all([runOriginal(cfg, stdin), sendLimits(cfg, input)]);
  return code;
}

main().then((code) => process.exit(code), () => process.exit(0));
