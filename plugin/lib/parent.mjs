// 오래 기다리는 훅(ask·inbox)이 클로드코드가 죽은 뒤에도 남아 서버에 계속 묻는 일이 없게 한다.
// 훅의 stdin은 입력을 받자마자 닫히므로 신호가 되지 못한다. 그래서 부모 프로세스가 살아 있는지 주기적으로 본다.
// 클로드코드는 훅을 셸을 거쳐 실행하기도 하므로(클로드코드 → 셸 → node), 부모의 부모까지 본다.
import { execFile } from 'node:child_process';
import { tuneMs } from './stdin.mjs';

/** 그 pid의 프로세스가 살아 있는가(권한이 없어 신호를 못 보내는 경우도 살아 있는 것이다). */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** pid의 부모 pid를 알아낸다. 못 알아내면 null. 예외를 던지지 않는다. */
export function lookupParentOf(pid) {
  return new Promise((resolve) => {
    const done = (err, stdout) => {
      const n = Number.parseInt(String(stdout ?? '').trim(), 10);
      resolve(!err && Number.isInteger(n) && n > 1 ? n : null);
    };
    try {
      if (process.platform === 'win32') {
        // Windows는 부모가 죽어도 부모 pid 기록이 남고 그 번호가 다른 프로세스에 다시 쓰일 수 있다.
        // 부모보다 먼저 만들어진 프로세스일 때만 진짜 부모로 본다.
        const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}";`
          + 'if($p){$g=Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)";'
          + 'if($g -and $g.CreationDate -le $p.CreationDate){$g.ProcessId}}';
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000 }, done);
      } else {
        execFile('ps', ['-o', 'ppid=', '-p', String(Number(pid))], { timeout: 5000 }, done);
      }
    } catch {
      resolve(null);
    }
  });
}

/**
 * 부모(와 부모의 부모)가 죽으면 onDead를 부른다.
 * 부모의 부모는 조금 뒤에 한 번만 알아낸다 — 금방 끝나는 훅은 그 비용을 치르지 않는다.
 */
export function watchParent(onDead) {
  const parent = process.ppid;
  const watched = [parent];
  const check = () => {
    // POSIX에서는 부모가 죽으면 ppid가 바뀐다(init 등으로 넘어간다).
    if (process.ppid !== parent || watched.some((pid) => !isAlive(pid))) onDead();
  };
  setInterval(check, tuneMs('PARENT_POLL', 5000)).unref();
  setTimeout(() => {
    lookupParentOf(parent).then((grand) => {
      if (grand && grand !== process.pid && grand !== parent && isAlive(grand)) watched.push(grand);
    }).catch(() => {});
  }, tuneMs('PARENT_LOOKUP', 20_000)).unref();
}
