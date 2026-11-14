// 디스크 큐. 서버가 죽어 있어도 이벤트를 잃지 않고, 살아나면 넣은 순서대로 보낸다.
// 파일 하나에 묶음 하나. 파일 이름이 시간순으로 정렬된다.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { queueDir, writeJsonAtomic } from './config.mjs';

/** 큐에 둘 수 있는 묶음 수. 넘으면 오래된 것부터 버린다. */
export const QUEUE_LIMIT = 200;
/** 한 번 전송 최대 크기(바이트). shared/src/contract.ts 의 MAX_BATCH_BYTES 와 같아야 한다. */
export const MAX_BATCH_BYTES = 512 * 1024;
/** 묶음 하나에 담는 대화 줄의 목표 크기. machine·이벤트·JSON 껍데기 몫을 남겨 둔다. */
const BATCH_BUDGET_BYTES = 440 * 1024;
/** 다른 프로세스가 잡은 잠금이 이보다 오래됐으면 죽은 것으로 본다. */
const LOCK_STALE_MS = 15_000;

let counter = 0;

function listFiles() {
  try {
    return readdirSync(queueDir()).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

export function queueSize() {
  return listFiles().length;
}

/** 묶음 하나를 큐 끝에 넣는다. */
export function enqueue(batch) {
  const dir = queueDir();
  mkdirSync(dir, { recursive: true });
  // 시각(ms, 13자리) + 프로세스 안 순번 + 겹치지 않게 pid·난수
  counter += 1;
  const name = [
    String(Date.now()).padStart(13, '0'),
    String(counter).padStart(6, '0'),
    `${process.pid}${Math.random().toString(36).slice(2, 6)}`,
  ].join('-') + '.json';
  writeJsonAtomic(join(dir, name), batch);

  const files = listFiles();
  for (const old of files.slice(0, Math.max(0, files.length - QUEUE_LIMIT))) {
    rmSync(join(dir, old), { force: true });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 여러 훅 프로세스가 동시에 보내 순서가 섞이지 않게 잠금을 잡는다. 못 잡으면 false. */
async function acquireLock(lockPath, waitMs) {
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch { /* 그 사이 풀렸다 — 다시 시도 */ }
    }
    if (Date.now() >= until) return false;
    await sleep(60);
  }
}

/**
 * 큐를 오래된 것부터 보낸다. → 보낸 개수.
 * sendFn(batch)의 결과: true = 보냄(삭제), 'drop' = 다시 보내도 소용없음(삭제, 개수에 안 넣음),
 * 그 밖(false·예외) = 실패 → 거기서 멈춰 순서를 지킨다.
 * deadline(ms 시각)이 지나면 남은 것은 다음 기회로 미룬다.
 */
export async function flush(sendFn, { deadline = Infinity, lockWaitMs = 1500 } = {}) {
  const dir = queueDir();
  if (listFiles().length === 0) return 0;
  const lockPath = join(dir, '.lock');
  const wait = Math.max(0, Math.min(lockWaitMs, deadline - Date.now()));
  if (!(await acquireLock(lockPath, wait))) return 0;

  let sent = 0;
  try {
    // 보내는 동안 새로 들어온 것까지 비울 때까지 반복한다.
    for (;;) {
      const files = listFiles();
      if (files.length === 0) return sent;
      for (const name of files) {
        if (Date.now() >= deadline) return sent;
        const path = join(dir, name);
        let batch;
        try {
          batch = JSON.parse(readFileSync(path, 'utf8'));
        } catch {
          rmSync(path, { force: true }); // 깨진 파일(또는 방금 지워진 파일)은 버린다
          continue;
        }
        let result;
        try {
          result = await sendFn(batch);
        } catch {
          result = false;
        }
        if (result === true) {
          sent += 1;
          rmSync(path, { force: true });
        } else if (result === 'drop') {
          rmSync(path, { force: true });
        } else {
          return sent;
        }
      }
    }
  } finally {
    rmSync(lockPath, { force: true });
  }
}

/**
 * {events, transcript:[{sessionId, seq, lines}], limits?} 를 512KB를 넘지 않는 묶음 여러 개로 나눈다.
 * 이벤트와 한도는 첫 묶음에만 넣고, 대화 줄은 순번(seq)을 이어 가며 나눠 담는다.
 */
export function splitBatches({ events = [], transcript = [], limits } = {}) {
  const batches = [];
  let current = { events, transcript: [] };
  if (limits) current.limits = limits;
  let used = Buffer.byteLength(JSON.stringify(events)) + (limits ? Buffer.byteLength(JSON.stringify(limits)) : 0);
  let hasContent = events.length > 0 || Boolean(limits);

  const push = () => {
    if (hasContent) batches.push(current);
    current = { events: [], transcript: [] };
    used = 0;
    hasContent = false;
  };

  for (const chunk of transcript) {
    let open = null; // 지금 묶음 안에서 이 세션의 줄을 받고 있는 조각
    chunk.lines.forEach((line, i) => {
      const size = Buffer.byteLength(JSON.stringify(line)) + 1;
      if (hasContent && used + size > BATCH_BUDGET_BYTES) {
        push();
        open = null;
      }
      if (!open) {
        open = { sessionId: chunk.sessionId, seq: chunk.seq + i, lines: [] };
        current.transcript.push(open);
        used += 200;
      }
      open.lines.push(line);
      used += size;
      hasContent = true;
    });
  }
  push();
  return batches;
}
