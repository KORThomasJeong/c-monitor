#!/usr/bin/env node
// 상태줄 래퍼. 연결 명령이 이 파일을 $C_MONITOR_HOME/bin/ 으로 복사해 settings.json의 statusLine으로 등록한다.
// 따로 복사돼 실행되므로 lib를 import하지 않는 자급형 파일이다.
// 하는 일: ① 상태줄 입력의 한도(rate_limits, 계정별 60초에 한 번)와
//             세션별 컨텍스트 사용률·비용(값이 바뀌었을 때만, 세션별 60초에 한 번)을 서버로 보내고
//          ② 원래 상태줄 명령에 같은 입력을 넘겨 그 출력을 그대로 보여 준다.
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform, release } from 'node:os';
import { join } from 'node:path';

const SEND_EVERY_MS = 60_000;
const SEND_TIMEOUT_MS = 2000;
/** 세션 통계를 실은 요청이 400이면 이 시간 동안 통계를 보내지 않는다(옛 서버). */
const STATS_OFF_MS = 24 * 3600 * 1000;
/** 이 시간 넘게 보내지 않은 세션의 통계 기록은 지운다. */
const STATS_KEEP_MS = 24 * 3600 * 1000;
/** 통계 기록을 남겨 두는 세션 수의 상한 */
const STATS_MAX_SESSIONS = 200;

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

// lib/os.mjs 의 osLabel()과 같아야 한다(이 파일은 lib를 import할 수 없어 복제해 둔다. test/statusline.test.mjs가 확인한다).
const OS_NAMES = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
const osLabel = () => `${OS_NAMES[platform()] ?? platform()} ${release()}`.slice(0, 100);

/**
 * 서버가 연결을 해제했다(401)고 설정에 표시하고 큐에 남은 묶음을 버린다.
 * lib/config.mjs 의 markRevoked() + lib/queue.mjs 의 clearQueue()와 같아야 한다.
 */
function markRevoked(token) {
  const path = join(home, 'config.json');
  const cfg = readJson(path);
  // 그 사이 다시 연결해 토큰이 바뀌었으면 새 연결을 건드리지 않는다.
  if (!cfg || typeof cfg !== 'object' || cfg.token !== token) return;
  if (!cfg.revokedAt) {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...cfg, revokedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    try {
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }
  const queue = join(home, 'queue');
  let files = [];
  try {
    files = readdirSync(queue).filter((f) => f.endsWith('.json'));
  } catch { /* 큐 폴더가 없음 */ }
  for (const name of files) rmSync(join(queue, name), { force: true });
}

const pct = (v) => (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0);
const epoch = (v) => (Number.isFinite(v) ? Math.round(v) : null);

/**
 * JSON을 보낸다. → 응답 상태 코드(닿지 않았거나 제한시간을 넘기면 0). 전역 fetch 대신 node:http/https — Windows의 Node 26에서
 * fetch 뒤에 process.exit()을 부르면 프로세스가 비정상 종료하기 때문이다.
 */
function post(url, body, token) {
  return new Promise((done) => {
    let req = null;
    const stop = () => { try { req?.destroy(); } catch { /* 무시 */ } done(0); };
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
        res.on('end', () => { clearTimeout(timer); done(res.statusCode ?? 0); });
        res.on('error', () => { clearTimeout(timer); done(0); });
      });
      req.on('error', () => { clearTimeout(timer); done(0); });
      req.end(payload);
    } catch {
      clearTimeout(timer);
      stop();
    }
  });
}

/** 상태 파일을 임시 파일에 쓰고 이름을 바꾼다(다른 세션의 상태줄이 쓰다 만 파일을 읽지 않게). */
function writeState(name, value) {
  mkdirSync(join(home, 'state'), { recursive: true });
  const path = join(home, 'state', name);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const tokens = (v) => (finite(v) && v > 0 ? v : 0);

/**
 * 상태줄 입력에서 이 세션의 컨텍스트 사용률(%)과 비용(USD)을 읽는다. → { sessionId, contextPct, costUsd } 또는 null.
 * - contextPct: context_window.used_percentage, 없으면 current_usage의 입력+캐시 토큰 합 ÷ context_window_size ×100.
 *   0~100으로 맞추고 소수 1자리. 둘 다 없으면 null.
 * - costUsd: cost.total_cost_usd(0 이상), 없으면 null.
 * 둘 다 null이면 보낼 것이 없으므로 null. 모양이 달라도 예외를 던지지 않는다.
 */
function readSessionStats(input) {
  try {
    const sessionId = input?.session_id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    const ctx = input.context_window && typeof input.context_window === 'object' ? input.context_window : null;
    let raw = null;
    if (finite(ctx?.used_percentage)) {
      raw = ctx.used_percentage;
    } else if (ctx && finite(ctx.context_window_size) && ctx.context_window_size > 0
      && ctx.current_usage && typeof ctx.current_usage === 'object') {
      const u = ctx.current_usage;
      if ([u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].some(finite)) {
        raw = ((tokens(u.input_tokens) + tokens(u.cache_creation_input_tokens) + tokens(u.cache_read_input_tokens))
          / ctx.context_window_size) * 100;
      }
    }
    const contextPct = raw === null ? null : Math.round(Math.min(100, Math.max(0, raw)) * 10) / 10;
    const cost = input.cost && typeof input.cost === 'object' ? input.cost.total_cost_usd : undefined;
    // 부동소수점 끝자리 흔들림을 "값이 바뀌었다"로 보지 않게 소수 6자리로 맞춘다.
    const costUsd = finite(cost) && cost >= 0 ? Math.round(cost * 1e6) / 1e6 : null;
    if (contextPct === null && costUsd === null) return null;
    return { sessionId: sessionId.slice(0, 200), contextPct, costUsd };
  } catch {
    return null;
  }
}

/** 한도 스냅샷을 만든다. 보낼 것이 없거나 계정별 60초 안에 이미 보냈으면 null(보낼 때는 전송 시각을 먼저 적는다). */
function takeLimits(input, now) {
  const limits = input?.rate_limits;
  if (!limits || typeof limits !== 'object') return null;
  const five = limits.five_hour;
  const seven = limits.seven_day;
  if (!Number.isFinite(five?.used_percentage) && !Number.isFinite(seven?.used_percentage)) return null;
  const account = readAccount();
  if (!account) return null;

  // 계정별 마지막 전송 시각. 보내기 전에 먼저 적어서 여러 세션이 한꺼번에 보내지 않게 한다.
  const state = readJson(join(home, 'state', 'limits.json')) ?? {};
  if (Number.isFinite(state[account]) && now - state[account] < SEND_EVERY_MS && now >= state[account]) return null;
  state[account] = now;
  writeState('limits.json', state);
  return {
    account,
    // 창이 하나만 있으면 없는 쪽은 0과 null
    fiveHourPct: pct(five?.used_percentage),
    fiveHourResetsAt: epoch(five?.resets_at),
    sevenDayPct: pct(seven?.used_percentage),
    sevenDayResetsAt: epoch(seven?.resets_at),
    at: new Date(now).toISOString(),
  };
}

/** state/stats.json 을 읽는다. 모양이 틀리면 빈 상태. */
function readStatsState() {
  const s = readJson(join(home, 'state', 'stats.json'));
  const sessions = s && typeof s.sessions === 'object' && s.sessions !== null && !Array.isArray(s.sessions) ? s.sessions : {};
  return { disabledUntil: finite(s?.disabledUntil) ? s.disabledUntil : null, sessions };
}

/** 오래된(24시간 넘게 보내지 않은) 세션 항목을 지우고, 너무 많으면 최근 것만 남긴다. */
function pruneStats(sessions, now) {
  const kept = Object.entries(sessions)
    .filter(([, e]) => e && typeof e === 'object' && finite(e.sentAt) && now - e.sentAt < STATS_KEEP_MS)
    .sort((a, b) => b[1].sentAt - a[1].sentAt)
    .slice(0, STATS_MAX_SESSIONS);
  return Object.fromEntries(kept);
}

/**
 * 세션 통계를 보낼지 정한다. → 보낼 항목 또는 null.
 * 조건: 400으로 거절당한 뒤 24시간이 안 지났으면 보내지 않음, 세션별 60초에 한 번까지,
 *       마지막으로 보낸 값과 같으면 보내지 않음(지난번 전송이 실패했으면 같아도 보냄).
 * 보내기로 했으면 전송 시각과 값을 먼저 적는다(같은 세션의 상태줄이 겹쳐 돌아도 한 번만 보내게).
 */
function takeSessionStats(input, now) {
  const stats = readSessionStats(input);
  if (!stats) return null;
  const state = readStatsState();
  if (state.disabledUntil !== null && now < state.disabledUntil) return null;
  const prev = state.sessions[stats.sessionId];
  const known = prev && typeof prev === 'object' && finite(prev.sentAt);
  if (known && now >= prev.sentAt && now - prev.sentAt < SEND_EVERY_MS) return null;
  if (known && prev.ok !== false && prev.contextPct === stats.contextPct && prev.costUsd === stats.costUsd) return null;
  state.sessions[stats.sessionId] = { contextPct: stats.contextPct, costUsd: stats.costUsd, sentAt: now };
  writeState('stats.json', { disabledUntil: null, sessions: pruneStats(state.sessions, now) });
  return { ...stats, at: new Date(now).toISOString(), prev: known ? prev : null };
}

/** 전송 결과를 통계 상태에 적는다. 400이면 24시간 끄고 기록을 되돌린다. 그 밖의 실패는 다음 차례에 같은 값이라도 다시 보내게 표시한다. */
function settleSessionStats(sent, status, now) {
  try {
    if (status >= 200 && status < 300) return;
    const state = readStatsState();
    if (status === 400) {
      state.disabledUntil = now + STATS_OFF_MS;
      // 서버가 받지 않은 값이므로 지난 기록으로 되돌린다.
      if (sent.prev) state.sessions[sent.sessionId] = sent.prev;
      else delete state.sessions[sent.sessionId];
    } else if (state.sessions[sent.sessionId]) {
      state.sessions[sent.sessionId] = { ...state.sessions[sent.sessionId], ok: false };
    }
    writeState('stats.json', { disabledUntil: state.disabledUntil, sessions: pruneStats(state.sessions, now) });
  } catch { /* 상태를 못 적어도 상태줄에는 영향이 없다 */ }
}

/**
 * 한도(계정별 60초에 한 번)와 세션 통계(세션별, 값이 바뀌었을 때만, 60초에 한 번)를 한 요청에 실어 보낸다.
 * 세션 통계를 실은 요청이 400이면(이 필드를 모르는 옛 서버) 24시간 통계를 끄고, 한도가 있었으면 한도만 다시 보낸다.
 * 모든 실패는 무시한다.
 */
async function sendStats(cfg, input) {
  try {
    if (!cfg || typeof cfg.server !== 'string' || typeof cfg.token !== 'string') return;
    if (cfg.revokedAt) return; // 서버에서 연결을 해제했으면 보내지 않는다(다시 연결하면 풀린다)
    const now = Date.now();
    let limits = null;
    try { limits = takeLimits(input, now); } catch { /* 한도 쪽이 실패해도 통계는 따로 본다 */ }
    let stats = null;
    try { stats = takeSessionStats(input, now); } catch { /* 통계 쪽이 실패해도 한도는 보낸다 */ }
    if (!limits && !stats) return;

    const url = `${cfg.server.replace(/\/+$/, '')}/api/ingest`;
    const base = {
      machine: {
        name: String(cfg.machineName || hostname() || 'unknown').slice(0, 100),
        os: osLabel(),
        pluginVersion: String(cfg.pluginVersion || '0.0.0').slice(0, 40),
      },
      events: [],
      transcript: [],
      ...(limits ? { limits } : {}),
    };
    const body = stats
      ? { ...base, sessionStats: [{ sessionId: stats.sessionId, contextPct: stats.contextPct, costUsd: stats.costUsd, at: stats.at }] }
      : base;
    let status = await post(url, body, cfg.token);
    if (stats) settleSessionStats(stats, status, now);
    // 옛 서버가 새 필드 때문에 거절했으면 한도만 다시 보낸다(한도 전송이 끊기지 않게).
    if (stats && status === 400 && limits) status = await post(url, base, cfg.token);
    if (status === 401) markRevoked(cfg.token); // 403(사용자 정지)은 해제가 아니다
  } catch { /* 전송 실패는 상태줄에 영향을 주지 않는다 */ }
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

  // 전송과 원래 명령 실행을 동시에 진행한다(전송을 기다리느라 출력이 늦어지지 않게).
  const [code] = await Promise.all([runOriginal(cfg, stdin), sendStats(cfg, input)]);
  return code;
}

main().then((code) => process.exit(code), () => process.exit(0));
