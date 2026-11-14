// 텔레그램 봇의 프로세스 내 상태: 지금 쓰는 봇, 받기(getUpdates long-poll) 루프, 보내기 큐, 30초 묶기.
// 서버 한 대를 전제로 한다(받기 루프가 둘이면 텔레그램이 409로 거절한다).
import type { Deps } from '../types';
import { handleUpdate } from './bot';
import { errorLine, TelegramError, type TelegramClient, type TgUpdate } from './telegram';

export type TelegramBot = { client: TelegramClient; username: string; token: string };
export type PollingState = 'ok' | 'error' | 'off';

export type TelegramHub = {
  /** 지금 쓰는 봇(없으면 텔레그램 기능 꺼짐). */
  readonly bot: TelegramBot | null;
  /**
   * 일반 "답을 기다림" 알림을 늦추는 시간(ms). 승인·질문 등록(ask)이 곧 뒤따르면 그쪽(버튼 있는 알림)만 보내려고.
   */
  readonly waitGraceMs: number;
  status(): { polling: PollingState; lastError: string | null };
  /** 봇을 바꾸고 받기 루프를 (다시) 시작한다. 옛 루프가 끝난 뒤에 돌아온다. */
  start(deps: Deps, bot: TelegramBot): Promise<void>;
  /** 받기 루프를 멈추고 봇을 끈다. */
  stop(): Promise<void>;
  /** 보내기 큐에 일을 넣는다. 요청 처리 흐름을 막지 않고, 실패는 로그만 남긴다. */
  enqueue(name: string, task: (bot: TelegramBot) => Promise<void>): void;
  /** ms 뒤에 큐에 넣는다. */
  later(ms: number, name: string, task: (bot: TelegramBot) => Promise<void>): void;
  /** 텔레그램 호출 하나. 429면 retry_after만큼 기다렸다 다시 한다. */
  call<T>(fn: () => Promise<T>): Promise<T>;
  /** 같은 키(세션·종류)는 windowMs 안에 한 번만 → 보내도 되면 true(그리고 시각을 적는다). */
  throttle(key: string, now: Date): boolean;
  /** 큐와 예약된 일이 모두 끝날 때까지 기다린다(테스트·종료용). */
  idle(): Promise<void>;
};

export type HubOptions = {
  /** 기다리기(429 대기·오류 뒤 쉬기). 테스트에서 줄인다. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** getUpdates가 붙잡는 시간(초). */
  pollTimeoutSec?: number;
  /** 같은 세션·같은 종류를 묶는 시간(ms). */
  throttleMs?: number;
  /** 일반 기다림 알림을 늦추는 시간(ms). 기본 4초. */
  waitGraceMs?: number;
  /** 받은 업데이트 하나를 처리한다. 기본은 bot.ts의 handleUpdate. */
  onUpdate?: (deps: Deps, update: TgUpdate) => Promise<void>;
};

const RETRY_429 = 3;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const THROTTLE_MS = 30_000;
/** 받기 루프가 기다리는 업데이트 종류. */
const ALLOWED_UPDATES = ['message', 'callback_query'];

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done);
  });
}

export function createTelegramHub(opts: HubOptions = {}): TelegramHub {
  const sleep = opts.sleep ?? defaultSleep;
  const throttleMs = opts.throttleMs ?? THROTTLE_MS;
  let bot: TelegramBot | null = null;
  let polling: PollingState = 'off';
  let lastError: string | null = null;
  let loop: { abort: AbortController; done: Promise<void> } | null = null;

  /** 보내기 큐(하나씩 차례로). */
  let chain: Promise<void> = Promise.resolve();
  const inflight = new Set<Promise<unknown>>();
  const timers = new Set<NodeJS.Timeout>();
  const lastSent = new Map<string, number>();

  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p)).catch(() => {});
    return p;
  };

  async function call<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof TelegramError && err.code === 429 && attempt < RETRY_429) {
          await sleep((err.retryAfter ?? 1) * 1000);
          continue;
        }
        throw err;
      }
    }
  }

  async function runLoop(deps: Deps, b: TelegramBot, signal: AbortSignal): Promise<void> {
    let offset = 0;
    let backoff = BACKOFF_MIN_MS;
    while (!signal.aborted) {
      let updates: TgUpdate[];
      try {
        updates = await b.client.getUpdates(
          { offset, timeout: opts.pollTimeoutSec ?? 25, allowed_updates: ALLOWED_UPDATES }, signal,
        );
      } catch (err) {
        if (signal.aborted) break;
        polling = 'error';
        lastError = errorLine(err, b.token);
        console.error('[telegram] 받기 실패:', lastError);
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        continue;
      }
      if (signal.aborted) break;
      polling = 'ok';
      lastError = null;
      backoff = BACKOFF_MIN_MS;
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        try {
          await track((opts.onUpdate ?? handleUpdate)(deps, u));
        } catch (err) {
          console.error('[telegram] 업데이트 처리 실패:', errorLine(err, b.token));
        }
      }
    }
  }

  async function stopLoop(): Promise<void> {
    const cur = loop;
    loop = null;
    if (!cur) return;
    cur.abort.abort();
    await cur.done;
  }

  const hub: TelegramHub = {
    get bot() { return bot; },
    waitGraceMs: opts.waitGraceMs ?? 4_000,
    status: () => ({ polling: bot ? polling : 'off', lastError: bot ? lastError : null }),
    async start(deps, b) {
      await stopLoop();
      bot = b;
      polling = 'ok';
      lastError = null;
      const abort = new AbortController();
      const done = runLoop(deps, b, abort.signal).catch((err) => {
        console.error('[telegram] 받기 루프가 멈췄습니다:', errorLine(err, b.token));
      });
      loop = { abort, done };
    },
    async stop() {
      await stopLoop();
      bot = null;
      polling = 'off';
      lastError = null;
    },
    enqueue(name, task) {
      if (!bot) return;
      const next = chain.then(async () => {
        const b = bot;
        if (!b) return;
        try {
          await task(b);
        } catch (err) {
          console.error(`[telegram] ${name} 실패:`, errorLine(err, b.token));
        }
      });
      chain = next;
      track(next);
    },
    later(ms, name, task) {
      if (!bot) return;
      if (ms <= 0) return hub.enqueue(name, task);
      let resolve!: () => void;
      const waiting = new Promise<void>((r) => { resolve = r; });
      track(waiting);
      const t = setTimeout(() => {
        timers.delete(t);
        hub.enqueue(name, task);
        resolve();
      }, ms);
      timers.add(t);
    },
    call,
    throttle(key, now) {
      const t = now.getTime();
      const prev = lastSent.get(key);
      if (prev !== undefined && t - prev < throttleMs && t >= prev) return false;
      lastSent.set(key, t);
      if (lastSent.size > 5_000) {
        for (const [k, v] of lastSent) if (t - v >= throttleMs) lastSent.delete(k);
      }
      return true;
    },
    async idle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
  return hub;
}
