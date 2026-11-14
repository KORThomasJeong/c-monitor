#!/usr/bin/env node
// 연결 명령.
//   connect.mjs <서버주소>           이 컴퓨터를 서버에 연결한다(브라우저에서 승인할 때까지 기다린다).
//   connect.mjs <서버주소> --start   연결을 요청하고 승인 링크·확인 코드를 출력한 뒤 바로 끝난다.
//   connect.mjs --wait               --start로 시작한 요청이 승인될 때까지 기다려 연결을 마친다.
//   connect.mjs --status             연결 상태를 보여 준다.
//   connect.mjs --disconnect         연결을 끊고 상태줄을 원래대로 돌린다.
//   --no-open (또는 환경변수 C_MONITOR_NO_OPEN=1)  승인 링크를 브라우저로 자동으로 열지 않는다.
//
// 두 단계로 나눈 이유: 클로드코드의 Bash 도구는 명령이 끝나야 출력을 보여 주므로,
// 링크를 출력하고 기다리기까지 한 번에 하면 사용자가 링크를 보지 못한 채 기다리게 된다.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAccount } from '../lib/account.mjs';
import { openBrowser } from '../lib/browser.mjs';
import {
  claudeConfigDir, deleteConfig, deletePending, loadConfig, loadPending, pluginVersion, saveConfig, savePending,
  statusHome, writeJsonAtomic,
} from '../lib/config.mjs';
import { osLabel } from '../lib/os.mjs';
import { queueSize } from '../lib/queue.mjs';
import { postJson } from '../lib/send.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const say = (line = '') => process.stdout.write(line + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const settingsPath = () => join(claudeConfigDir(), 'settings.json');
const wrapperPath = () => join(statusHome(), 'bin', 'statusline.mjs');
/** settings.json에 등록하는 명령. Windows에서도 슬래시 경로를 써서 어떤 셸에서든 같게 읽히게 한다. */
const wrapperCommand = () => `node "${wrapperPath().replace(/\\/g, '/')}"`;
const isWrapper = (statusLine) => typeof statusLine?.command === 'string' && statusLine.command === wrapperCommand();

/** settings.json을 읽는다. → {exists, settings} / 읽을 수 없으면 {exists:true, settings:null} */
function readSettings() {
  const path = settingsPath();
  if (!existsSync(path)) return { exists: false, settings: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { exists: true, settings: parsed };
  } catch { /* 아래에서 처리 */ }
  return { exists: true, settings: null };
}

/** 고치기 전 내용을 백업한 뒤 settings.json을 쓴다. 다른 키는 그대로 둔다. */
function writeSettings(settings, existed) {
  const path = settingsPath();
  if (existed) copyFileSync(path, path + '.c-monitor.bak');
  writeJsonAtomic(path, settings, { pretty: true });
}

/**
 * 상태줄 래퍼를 설치한다. → {ok, original}
 * original: 감싸기 전의 statusLine 값(없었으면 null). 이미 감싸져 있으면 previousOriginal을 그대로 쓴다.
 */
function installStatusLine(previousOriginal) {
  mkdirSync(dirname(wrapperPath()), { recursive: true });
  copyFileSync(join(HERE, 'statusline.mjs'), wrapperPath());

  const { exists, settings } = readSettings();
  if (settings === null) return { ok: false, original: previousOriginal ?? null };
  if (isWrapper(settings.statusLine)) return { ok: true, original: previousOriginal ?? null };

  const original = settings.statusLine ?? null;
  writeSettings({ ...settings, statusLine: { type: 'command', command: wrapperCommand() } }, exists);
  return { ok: true, original };
}

/** 상태줄을 원래대로 돌린다(원래 없었으면 키 삭제). 우리가 등록한 래퍼일 때만 손댄다. */
function restoreStatusLine(original) {
  const { exists, settings } = readSettings();
  if (!exists) return 'none';
  if (settings === null) return 'unreadable';
  if (!isWrapper(settings.statusLine)) return 'untouched';
  const next = { ...settings };
  if (original && typeof original === 'object') next.statusLine = original;
  else delete next.statusLine;
  writeSettings(next, true);
  return 'restored';
}

function normalizeServer(arg) {
  let url = arg.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

const USAGE = '사용법: connect.mjs <서버주소> [--start] [--no-open] | --wait | --status | --disconnect';
const GONE = '✗ 거부되었거나 만료되었습니다. 다시 연결해 주세요.';

/**
 * 1단계: 서버에 연결을 요청하고 승인 링크·확인 코드를 출력한다(브라우저도 연다).
 * → 진행 중인 요청 {server, deviceCode, userCode, verifyUrl, interval, expiresAt} / 실패하면 null(안내는 이미 출력).
 */
async function startRequest(serverArg, { noOpen }) {
  const server = normalizeServer(serverArg);
  if (!server) {
    say(`✗ 서버 주소를 읽을 수 없습니다: ${serverArg}`);
    return null;
  }
  const start = await postJson(`${server}/api/device/start`, { machineName: hostname(), os: osLabel(), pluginVersion: pluginVersion() }, null, 10_000);
  if (!start.ok || !start.json?.deviceCode) {
    say(`✗ 서버에 연결하지 못했습니다: ${server}${start.status ? ` (응답 ${start.status})` : ''}`);
    say('  주소가 맞는지, 서버가 켜져 있는지 확인해 주세요.');
    return null;
  }
  const { deviceCode, userCode, verifyUrl } = start.json;
  const interval = Number.isFinite(start.json.interval) && start.json.interval > 0 ? start.json.interval : 3;
  const expiresIn = Number.isFinite(start.json.expiresIn) && start.json.expiresIn > 0 ? start.json.expiresIn : 600;

  const opened = await openBrowser(verifyUrl, { noOpen });
  say('● 서버에 연결을 요청했습니다.');
  say(opened
    ? '  브라우저를 열었습니다. 구글로 로그인한 뒤 코드를 확인하고 승인해 주세요. (열리지 않았다면 아래 링크로 들어가면 됩니다.)'
    : '  아래 링크를 직접 열어 주세요. 구글로 로그인한 뒤 코드를 확인하고 승인하면 됩니다.');
  say('');
  say(`  ${verifyUrl}`);
  say(`  확인 코드  ${userCode}`);
  say('');
  say(`  ${Math.max(1, Math.round(expiresIn / 60))}분 안에 승인하지 않으면 코드가 만료됩니다.`);
  return { server, deviceCode, userCode, verifyUrl, interval, expiresAt: Date.now() + expiresIn * 1000 };
}

/** 2단계: 승인될 때까지 poll하고, 승인되면 설정을 저장하고 상태줄 래퍼를 설치한다. → 종료 코드 */
async function waitForApproval(pending) {
  const { server, deviceCode } = pending;
  const interval = Number.isFinite(pending.interval) && pending.interval > 0 ? pending.interval : 3;
  const until = Number.isFinite(pending.expiresAt) ? pending.expiresAt : Date.now() + 600_000;
  const version = pluginVersion();

  let approved = null;
  while (Date.now() < until) {
    await sleep(interval * 1000);
    const poll = await postJson(`${server}/api/device/poll`, { deviceCode }, null, 10_000);
    if (poll.status === 200 && poll.json?.token) {
      approved = poll.json;
      break;
    }
    if (poll.status === 410) break;
    // 202(대기)나 일시적인 오류는 계속 기다린다.
  }
  if (!approved) {
    say(GONE);
    return 1;
  }

  const machineName = approved.machineName || hostname();
  const previous = loadConfig();
  const base = {
    server,
    token: approved.token,
    machineId: approved.machineId,
    machineName,
    pluginVersion: version,
    originalStatusLine: previous?.originalStatusLine ?? null,
  };
  // 상태줄 설치가 실패해도 연결은 남게 먼저 저장한다. 새로 만든 설정이므로 예전의 해제 표시(revokedAt)는 사라진다.
  saveConfig(base);
  say(`✓ 승인되었습니다. 이 컴퓨터를 ${machineName} 로 등록했습니다.`);

  let installed;
  try {
    installed = installStatusLine(base.originalStatusLine);
  } catch (err) {
    installed = { ok: false, original: base.originalStatusLine, error: err };
  }
  if (installed.ok) {
    saveConfig({ ...base, originalStatusLine: installed.original });
    say(installed.original?.command
      ? '✓ 상태줄에 한도 전송을 연결했습니다. 기존 상태줄은 그대로 보입니다.'
      : '✓ 상태줄에 한도 전송을 연결했습니다.');
  } else {
    say(`! settings.json을 읽거나 고칠 수 없어 상태줄은 건드리지 않았습니다(${settingsPath()}).`);
    say('  세션 전송은 되지만 5시간·주간 한도는 전송되지 않습니다. 직접 등록하려면 statusLine 명령을 아래로 바꿔 주세요.');
    say(`  ${wrapperCommand()}`);
  }
  say('  이제 이 컴퓨터의 모든 세션이 자동으로 전송됩니다.');
  return 0;
}

/** 한 번에: 요청하고 승인될 때까지 기다린다(터미널에서 직접 실행하는 사람용). */
async function connect(serverArg, opts) {
  const pending = await startRequest(serverArg, opts);
  if (!pending) return 1;
  say('  승인을 기다리는 중…');
  return waitForApproval(pending);
}

/** --start: 요청만 하고 바로 끝난다. 이어서 쓸 값은 pending.json에 둔다(이미 있으면 새 요청으로 덮어쓴다). */
async function startOnly(serverArg, opts) {
  const pending = await startRequest(serverArg, opts);
  if (!pending) return 1;
  savePending(pending);
  return 0;
}

/** --wait: --start가 남긴 요청을 이어받아 승인을 기다린다. 끝나면(성공·거부·만료) pending.json을 지운다. */
async function waitOnly() {
  const pending = loadPending();
  if (!pending) {
    deletePending(); // 모양이 틀린 파일이 남아 있었다면 치운다
    say('✗ 진행 중인 연결 요청이 없습니다. /c-monitor:connect <서버주소>부터 실행해 주세요.');
    return 1;
  }
  try {
    return await waitForApproval(pending);
  } finally {
    deletePending();
  }
}

function status() {
  const cfg = loadConfig();
  if (!cfg) {
    say('○ 연결되어 있지 않습니다.');
    say('  연결하려면 서버 주소를 붙여 실행해 주세요. 예: /c-monitor:connect https://c-monitor.example.com');
    return 0;
  }
  if (cfg.revokedAt) {
    say('○ 서버에서 연결이 해제되었습니다. 이 컴퓨터의 세션은 전송되지 않습니다.');
    say(`  다시 연결하려면 /c-monitor:connect ${cfg.server} 를 실행하세요.`);
    return 0;
  }
  const { settings } = readSettings();
  say('● 연결되어 있습니다.');
  say(`  서버        ${cfg.server}`);
  say(`  컴퓨터      ${cfg.machineName ?? hostname()}`);
  say(`  클로드 계정 ${readAccount() ?? '(확인할 수 없음)'}`);
  say(`  상태줄      ${settings && isWrapper(settings.statusLine) ? '한도 전송 연결됨' : '연결 안 됨'}`);
  say(`  보낼 묶음   ${queueSize()}개 남음`);
  return 0;
}

/**
 * 서버에 이 기기의 연결 해제를 알린다(기기 토큰 폐기). → 서버가 알게 됐으면 true.
 * 401은 서버가 이미 폐기한 토큰이라는 뜻이므로 알린 것으로 본다.
 */
async function notifyServerDisconnect(cfg) {
  if (cfg.revokedAt) return true; // 서버가 먼저 해제했다 — 알릴 것이 없다
  const r = await postJson(`${cfg.server.replace(/\/+$/, '')}/api/device/disconnect`, {}, cfg.token, 3000);
  return r.ok || r.status === 401;
}

async function disconnect() {
  const cfg = loadConfig();
  const result = restoreStatusLine(cfg?.originalStatusLine ?? null);
  if (result === 'restored') say('✓ 상태줄을 원래대로 돌렸습니다.');
  else if (result === 'unreadable') say(`! settings.json을 읽을 수 없어 상태줄은 건드리지 않았습니다(${settingsPath()}).`);
  if (!cfg) {
    say('○ 연결되어 있지 않습니다.');
    return 0;
  }
  // 서버에 닿지 않아도 로컬 해제는 끝까지 한다.
  const notified = await notifyServerDisconnect(cfg);
  deleteConfig();
  say(`✓ 연결을 끊었습니다(${cfg.server}). 이 컴퓨터의 세션은 더 이상 전송되지 않습니다.`);
  if (!notified) say('! 서버에는 알리지 못했습니다. 웹의 설정 화면에서 이 컴퓨터를 해제해 주세요.');
  return 0;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a.trim().length > 0);
  const flags = new Set(args.filter((a) => a.startsWith('-')));
  const positional = args.filter((a) => !a.startsWith('-'));
  const known = ['--start', '--wait', '--no-open', '--status', '--disconnect', '--help', '-h'];
  const unknown = [...flags].find((f) => !known.includes(f));
  if (unknown) {
    say(`✗ 모르는 옵션입니다: ${unknown}`);
    say(USAGE);
    return 1;
  }
  if (flags.has('--help') || flags.has('-h')) {
    say(USAGE);
    return 0;
  }
  // 상태·해제는 다른 옵션이 함께 와도 그대로 한다.
  if (flags.has('--disconnect')) return disconnect();
  if (flags.has('--status')) return status();
  if (flags.has('--wait')) return waitOnly();

  const server = positional[0];
  const opts = { noOpen: flags.has('--no-open') };
  if (flags.has('--start')) {
    if (!server) {
      say('✗ 서버 주소가 필요합니다.');
      say(USAGE);
      return 1;
    }
    return startOnly(server, opts);
  }
  if (!server) return status();
  return connect(server, opts);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    say(`✗ 오류가 났습니다: ${err?.message ?? err}`);
    process.exit(1);
  },
);
