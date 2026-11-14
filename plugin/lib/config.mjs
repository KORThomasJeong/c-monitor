// 플러그인 상태 저장 위치와 설정 파일.
// 모든 상태는 $C_MONITOR_HOME(기본 ~/.c-monitor) 아래에 둔다.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 상태 저장 폴더. config.json, queue/, state/, bin/ 이 들어간다. */
export function statusHome() {
  return process.env.C_MONITOR_HOME || join(homedir(), '.c-monitor');
}

/** 클로드코드 설정 폴더(settings.json이 있는 곳). */
export function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export const configPath = () => join(statusHome(), 'config.json');
/** 진행 중인 연결 요청(--start가 쓰고 --wait가 읽는다). */
export const pendingPath = () => join(statusHome(), 'pending.json');
export const queueDir = () => join(statusHome(), 'queue');
export const stateDir = () => join(statusHome(), 'state');

/** JSON 파일을 읽는다. 없거나 깨졌으면 null. */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** JSON 파일을 통째로 바꿔 쓴다(임시 파일에 쓰고 이름 바꾸기 — 쓰다 만 파일이 남지 않게). */
export function writeJsonAtomic(path, value, { pretty = false, mode } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, pretty ? 2 : 0) + (pretty ? '\n' : ''), mode ? { mode } : undefined);
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * 연결 설정 {server, token, machineId, machineName, originalStatusLine, revokedAt?}. 연결 전이면 null.
 * revokedAt이 있으면 서버가 이 기기의 연결을 해제한 것이다 — 훅과 상태줄 래퍼는 아무것도 보내지 않는다.
 */
export function loadConfig() {
  const cfg = readJson(configPath());
  if (!cfg || typeof cfg !== 'object' || typeof cfg.server !== 'string' || typeof cfg.token !== 'string') return null;
  return cfg;
}

/** 연결 설정 저장. 토큰이 들어 있으므로 본인만 읽게 한다(Windows에서는 권한 값이 무시된다). */
export function saveConfig(obj) {
  writeJsonAtomic(configPath(), obj, { pretty: true, mode: 0o600 });
}

/**
 * 서버가 연결을 해제했다고(수집 API의 401) 설정에 표시한다. → 표시했으면(이미 돼 있어도) true.
 * 그 사이 다시 연결해 토큰이 바뀌었으면 새 연결을 건드리지 않고 false.
 * 같은 규칙이 bin/statusline.mjs 안에도 있다.
 */
export function markRevoked(token) {
  const cfg = loadConfig();
  if (!cfg || cfg.token !== token) return false;
  if (!cfg.revokedAt) saveConfig({ ...cfg, revokedAt: new Date().toISOString() });
  return true;
}

export function deleteConfig() {
  rmSync(configPath(), { force: true });
}

/** 진행 중인 연결 요청 {server, deviceCode, userCode, verifyUrl, interval, expiresAt}. 없거나 모양이 틀리면 null. */
export function loadPending() {
  const p = readJson(pendingPath());
  if (!p || typeof p !== 'object' || typeof p.server !== 'string' || typeof p.deviceCode !== 'string') return null;
  return p;
}

/** 기기 코드가 들어 있으므로 본인만 읽게 한다. */
export function savePending(obj) {
  writeJsonAtomic(pendingPath(), obj, { pretty: true, mode: 0o600 });
}

export function deletePending() {
  rmSync(pendingPath(), { force: true });
}

/** 플러그인 버전(plugin.json). 읽지 못하면 0.0.0. */
export function pluginVersion() {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifest = readJson(join(here, '..', '.claude-plugin', 'plugin.json'));
  return typeof manifest?.version === 'string' ? manifest.version : '0.0.0';
}
