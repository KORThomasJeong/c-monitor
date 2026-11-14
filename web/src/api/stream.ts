// 실시간 스트림(SSE). 끊기면 브라우저가 스스로 다시 붙고,
// 완전히 닫힌 경우(서버 오류 응답 등)에는 3초 뒤 새로 연결한다.
// 서버는 연결될 때마다 snapshot을 먼저 보내므로 재연결 뒤 빠진 상태가 없다.
import { API, type StreamMessage } from '@c-monitor/shared';

const TYPES = new Set(['snapshot', 'session', 'log', 'limits', 'machine', 'removed']);

export type StreamHandlers = {
  onMessage: (msg: StreamMessage) => void;
  /** true = 연결됨, false = 끊겨서 다시 붙는 중 */
  onStatus?: (connected: boolean) => void;
};

export type StreamOptions = {
  url?: string;
  retryMs?: number;
  EventSourceImpl?: typeof EventSource;
};

export function parseMessage(data: string): StreamMessage | null {
  try {
    const m = JSON.parse(data) as { type?: unknown };
    return m && typeof m === 'object' && typeof m.type === 'string' && TYPES.has(m.type)
      ? (m as StreamMessage)
      : null;
  } catch {
    return null;
  }
}

/** 스트림에 붙는다. 돌려받은 함수를 부르면 닫고 재시도도 멈춘다. */
export function connectStream(handlers: StreamHandlers, opts: StreamOptions = {}): () => void {
  const url = opts.url ?? API.stream;
  const retryMs = opts.retryMs ?? 3000;
  const ES = opts.EventSourceImpl ?? globalThis.EventSource;
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const open = () => {
    if (stopped) return;
    const cur = new ES(url, { withCredentials: true });
    es = cur;
    cur.onopen = () => handlers.onStatus?.(true);
    cur.onmessage = (e: MessageEvent) => {
      const msg = parseMessage(String(e.data));
      if (msg) handlers.onMessage(msg);
    };
    cur.onerror = () => {
      handlers.onStatus?.(false);
      // CONNECTING이면 브라우저가 알아서 다시 붙는다. CLOSED면 우리가 다시 만든다.
      if (cur.readyState === 2 /* CLOSED */ && !stopped && !timer) {
        cur.close();
        timer = setTimeout(() => { timer = null; open(); }, retryMs);
      }
    };
  };

  open();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    es?.close();
  };
}
