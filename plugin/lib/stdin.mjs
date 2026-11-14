// 훅 입력 읽기와, 테스트에서 줄일 수 있는 시간 값.

/** stdin 전체를 읽는다. 입력이 안 오면 1초 뒤 포기한다. */
export function readStdin() {
  return new Promise((done) => {
    const chunks = [];
    const finish = () => done(Buffer.concat(chunks).toString('utf8'));
    const timer = setTimeout(finish, 1000);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => { clearTimeout(timer); finish(); });
    process.stdin.on('error', () => { clearTimeout(timer); finish(); });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 시간 값(밀리초). 환경변수 C_MONITOR_<이름>_MS 로 바꿀 수 있다(테스트용). */
export function tuneMs(name, fallback) {
  const n = Number(process.env[`C_MONITOR_${name}_MS`]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
