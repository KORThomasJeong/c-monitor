// 승인 링크를 기본 브라우저로 연다. 어떤 경우에도 예외를 던지지 않고, 실제로 열었는지만 알려 준다.
import { spawn as nodeSpawn } from 'node:child_process';

/** 실행이 시작됐는지 기다리는 최대 시간. */
const SPAWN_WAIT_MS = 1500;

/**
 * 주소를 여는 명령을 고른다. → {file, args} / 열지 않아야 하면 null.
 * 열지 않는 경우: C_MONITOR_NO_OPEN이 켜짐, http·https 주소가 아님(서버가 준 주소로 다른 프로그램을 띄우지 않게),
 * 화면이 없는 환경(SSH 접속, Linux에서 DISPLAY·WAYLAND_DISPLAY 없음), 모르는 운영체제.
 * 셸을 거치지 않고 인자로 넘기므로 주소의 & 같은 글자는 그대로 전달된다.
 */
export function browserCommand(url, { platform = process.platform, env = process.env } = {}) {
  if (env.C_MONITOR_NO_OPEN && env.C_MONITOR_NO_OPEN !== '0') return null;
  let target;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return null;

  const href = target.href;
  if (platform === 'win32') return { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', href] };
  if (platform === 'darwin') return { file: 'open', args: [href] };
  if (platform === 'linux') {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
    return { file: 'xdg-open', args: [href] };
  }
  return null;
}

/**
 * 브라우저를 연다. → 열기를 시작했으면 true, 열지 않았거나 실패했으면 false.
 * 자식 프로세스는 떼어 놓고(detached·stdio ignore·unref) 띄워 이 스크립트의 종료를 막지 않는다.
 * noOpen: --no-open 옵션. spawn: 테스트에서 가짜를 넣는다.
 */
export function openBrowser(url, { platform, env, noOpen = false, spawn = nodeSpawn } = {}) {
  return new Promise((resolve) => {
    const command = noOpen ? null : browserCommand(url, { platform, env });
    if (!command) {
      resolve(false);
      return;
    }
    let timer = null;
    const done = (opened) => {
      clearTimeout(timer);
      resolve(opened);
    };
    try {
      const child = spawn(command.file, command.args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', () => done(false)); // 실행 파일이 없음(xdg-open 미설치 등)
      child.once('spawn', () => done(true));
      child.unref();
      timer = setTimeout(() => done(false), SPAWN_WAIT_MS);
      timer.unref?.();
    } catch {
      done(false);
    }
  });
}
