// SSE 응답 틀: 보내기, 주기적인 `: ping`, 핑마다 "아직 볼 자격이 있는가" 다시 확인, 끊김·끝내기 처리.
import type { Context } from 'hono';
import { stream } from 'hono/streaming';
import type { Deps } from '../types';

const PING_MS = 15_000;

export type SseIo = {
  /** data 메시지 하나를 보낸다(JSON). 이미 끊겼으면 아무 일도 없다. */
  send(msg: unknown): Promise<void>;
  /** 클라이언트가 끊었거나 end()가 불리면 풀린다. run은 이것을 기다린 뒤 정리하고 돌아온다. */
  ended: Promise<void>;
  /** 서버 쪽에서 스트림을 끝낸다(자격이 없어졌거나 세션이 지워짐). */
  end(): void;
  /** 순서를 지켜 하나씩 처리한다(버스 메시지 변환에 DB 조회가 끼어도 순서가 섞이지 않게). */
  serial(task: () => Promise<void>): void;
};

/**
 * SSE 스트림을 연다. recheck가 false를 돌려주면(핑 주기마다 부른다) 스트림을 끝낸다 —
 * 탈퇴·정지·공유 취소·만료가 열려 있던 스트림에도 늦어도 핑 한 번 안에 반영된다.
 */
export function openSse(c: Context, deps: Pick<Deps, 'pingMs'>, run: (io: SseIo) => Promise<void>, recheck?: () => Promise<boolean>): Response {
  c.header('Content-Type', 'text/event-stream; charset=utf-8');
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('X-Accel-Buffering', 'no'); // 프록시(nginx) 버퍼링 끔

  return stream(c, async (s) => {
    let closed = false;
    let endFn!: () => void;
    const ended = new Promise<void>((resolve) => { endFn = resolve; });
    const end = () => {
      closed = true;
      endFn();
    };
    s.onAbort(end);
    const write = async (chunk: string) => {
      if (closed) return;
      try {
        await s.write(chunk);
      } catch {
        end();
      }
    };
    let chain: Promise<void> = Promise.resolve();
    const serial = (task: () => Promise<void>) => {
      chain = chain.then(task).catch((err) => console.error('[stream] 메시지 처리 실패:', err));
    };
    const ping = setInterval(() => {
      void (async () => {
        if (recheck) {
          const ok = await recheck().catch((err) => {
            console.error('[stream] 자격 확인 실패:', err);
            return true; // DB가 잠깐 안 될 때는 끊지 않는다
          });
          if (!ok) return end();
        }
        await write(': ping\n\n');
      })();
    }, deps.pingMs ?? PING_MS);
    try {
      await run({ send: (msg) => write(`data: ${JSON.stringify(msg)}\n\n`), ended, end, serial });
    } finally {
      clearInterval(ping);
      closed = true;
    }
  });
}
