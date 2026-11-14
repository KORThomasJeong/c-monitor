// 운영체제 표기. 연결(connect)·훅(hook)이 이 함수를 쓰고, 상태줄 래퍼(bin/statusline.mjs)는
// 자급형 파일이라 같은 규칙을 그 안에 복제해 둔다 — 여기를 고치면 그쪽도 함께 고칠 것.
// 표기가 서로 다르면 묶음을 보낼 때마다 서버의 기기 정보가 다른 형태로 덮어써진다.
import { platform, release } from 'node:os';

const NAMES = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/** 예: "Windows 10.0.26200", "macOS 24.1.0", "Linux 6.8.0". 버전은 os.release() 값 그대로다. */
export function osLabel(p = platform(), r = release()) {
  return `${NAMES[p] ?? p} ${r}`.slice(0, 100);
}
