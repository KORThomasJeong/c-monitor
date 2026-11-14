#!/usr/bin/env node
// 연결 명령.
//   connect.mjs <서버주소>   이 컴퓨터를 서버에 연결한다(브라우저에서 승인).
//   connect.mjs --status     연결 상태를 보여 준다.
//   connect.mjs --disconnect 연결을 끊고 상태줄을 원래대로 돌린다.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { hostname, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAccount } from '../lib/account.mjs';
import {
  claudeConfigDir, deleteConfig, loadConfig, pluginVersion, saveConfig, statusHome, writeJsonAtomic,
} from '../lib/config.mjs';
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

function osSummary() {
  const names = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
  return `${names[platform()] ?? platform()} ${release()}`.slice(0, 100);
}

async function connect(serverArg) {
  const server = normalizeServer(serverArg);
  if (!server) {
    say(`✗ 서버 주소를 읽을 수 없습니다: ${serverArg}`);
    return 1;
  }
  const version = pluginVersion();
  const start = await postJson(`${server}/api/device/start`, { machineName: hostname(), os: osSummary(), pluginVersion: version }, null, 10_000);
  if (!start.ok || !start.json?.deviceCode) {
    say(`✗ 서버에 연결하지 못했습니다: ${server}${start.status ? ` (응답 ${start.status})` : ''}`);
    say('  주소가 맞는지, 서버가 켜져 있는지 확인해 주세요.');
    return 1;
  }
  const { deviceCode, userCode, verifyUrl } = start.json;
  const interval = Number.isFinite(start.json.interval) && start.json.interval > 0 ? start.json.interval : 3;
  const expiresIn = Number.isFinite(start.json.expiresIn) && start.json.expiresIn > 0 ? start.json.expiresIn : 600;

  say('● 서버에 연결을 요청했습니다.');
  say('  아래 링크를 열고 구글로 로그인한 뒤 코드를 확인해 주세요.');
  say('');
  say(`  ${verifyUrl}`);
  say(`  확인 코드  ${userCode}`);
  say('');
  say(`  ${Math.max(1, Math.round(expiresIn / 60))}분 안에 승인하지 않으면 코드가 만료됩니다.`);
  say('  승인을 기다리는 중…');

  const until = Date.now() + expiresIn * 1000;
  let approved = null;
  while (Date.now() < until) {
    await sleep(interval * 1000);
    const poll = await postJson(`${server}/api/device/poll`, { deviceCode }, null, 10_000);
    if (poll.status === 200 && poll.json?.token) {
      approved = poll.json;
      break;
    }
    if (poll.status === 410) {
      say('✗ 거부되었거나 만료되었습니다. 다시 연결해 주세요.');
      return 1;
    }
    // 202(대기)나 일시적인 오류는 계속 기다린다.
  }
  if (!approved) {
    say('✗ 거부되었거나 만료되었습니다. 다시 연결해 주세요.');
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
  saveConfig(base); // 상태줄 설치가 실패해도 연결은 남게 먼저 저장한다
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

function status() {
  const cfg = loadConfig();
  if (!cfg) {
    say('○ 연결되어 있지 않습니다.');
    say('  연결하려면 서버 주소를 붙여 실행해 주세요. 예: /c-monitor:connect https://c-monitor.example.com');
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

function disconnect() {
  const cfg = loadConfig();
  const result = restoreStatusLine(cfg?.originalStatusLine ?? null);
  if (result === 'restored') say('✓ 상태줄을 원래대로 돌렸습니다.');
  else if (result === 'unreadable') say(`! settings.json을 읽을 수 없어 상태줄은 건드리지 않았습니다(${settingsPath()}).`);
  if (!cfg) {
    say('○ 연결되어 있지 않습니다.');
    return 0;
  }
  deleteConfig();
  say(`✓ 연결을 끊었습니다(${cfg.server}). 이 컴퓨터의 세션은 더 이상 전송되지 않습니다.`);
  say('  대시보드의 컴퓨터 목록에서도 지우려면 웹 설정에서 삭제해 주세요.');
  return 0;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a.trim().length > 0);
  const first = args[0];
  if (!first || first === '--status') return status();
  if (first === '--disconnect') return disconnect();
  if (first === '--help' || first === '-h') {
    say('사용법: connect.mjs <서버주소> | --status | --disconnect');
    return 0;
  }
  if (first.startsWith('-')) {
    say(`✗ 모르는 옵션입니다: ${first}`);
    say('사용법: connect.mjs <서버주소> | --status | --disconnect');
    return 1;
  }
  return connect(first);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    say(`✗ 오류가 났습니다: ${err?.message ?? err}`);
    process.exit(1);
  },
);
