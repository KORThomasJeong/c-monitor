// 상태줄 래퍼 복사본($C_MONITOR_HOME/bin/statusline.mjs)을 설치하고 최신으로 유지한다.
// settings.json의 statusLine은 플러그인 폴더가 아니라 이 복사본을 가리킨다(플러그인 폴더는 버전마다 바뀐다).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, pluginVersion, saveConfig, statusHome } from './config.mjs';

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'statusline.mjs');

export const wrapperPath = () => join(statusHome(), 'bin', 'statusline.mjs');

/** 이 플러그인의 래퍼를 복사본 자리에 쓴다(임시 파일에 쓰고 이름 바꾸기 — 실행 중인 상태줄이 쓰다 만 파일을 읽지 않게). */
export function installWrapperFile() {
  const dest = wrapperPath();
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, readFileSync(SOURCE));
  try {
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** 버전 문자열 비교(숫자 마디만 본다). a가 b보다 높으면 양수. */
export function compareVersions(a, b) {
  const parts = (v) => String(v ?? '').split('.').map((p) => Number.parseInt(p, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 플러그인이 업데이트됐으면 래퍼 복사본도 새것으로 바꾸고 설정의 pluginVersion을 올린다. → 바꿨으면 true.
 * - 이 플러그인이 설정에 적힌 버전보다 높을 때만 한다(옛 버전 플러그인으로 도는 세션이 새 래퍼를 되돌리지 않게).
 * - 래퍼를 설치한 적이 없으면(연결할 때 settings.json을 고치지 못한 경우) 파일은 만들지 않는다.
 */
export function syncWrapper(cfg) {
  const version = pluginVersion();
  if (compareVersions(version, cfg?.pluginVersion) <= 0) return false;
  if (existsSync(wrapperPath())) installWrapperFile();
  // 그 사이 다시 연결했거나 해제 표시가 붙었을 수 있으니 지금 설정을 다시 읽어 버전만 바꾼다.
  const current = loadConfig();
  if (current && current.token === cfg.token) saveConfig({ ...current, pluginVersion: version });
  return true;
}
