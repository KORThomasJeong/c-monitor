import type { StreamMessage } from '@c-monitor/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectStream } from './stream';

class FakeES {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static all: FakeES[] = [];
  readyState = FakeES.CONNECTING;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  constructor(public url: string, public init?: EventSourceInit) { FakeES.all.push(this); }
  close() { this.closed = true; this.readyState = FakeES.CLOSED; }
  open() { this.readyState = FakeES.OPEN; this.onopen?.(new Event('open')); }
  send(data: string) { this.onmessage?.(new MessageEvent('message', { data })); }
  fail(closed: boolean) { this.readyState = closed ? FakeES.CLOSED : FakeES.CONNECTING; this.onerror?.(new Event('error')); }
}
const latest = () => FakeES.all[FakeES.all.length - 1]!;

beforeEach(() => { FakeES.all = []; vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('connectStream', () => {
  const setup = () => {
    const messages: StreamMessage[] = [];
    const status: boolean[] = [];
    const close = connectStream(
      { onMessage: (m) => messages.push(m), onStatus: (c) => status.push(c) },
      { EventSourceImpl: FakeES as unknown as typeof EventSource },
    );
    return { messages, status, close };
  };

  it('/api/stream에 쿠키와 함께 붙고 메시지를 StreamMessage로 넘긴다', () => {
    const { messages, status } = setup();
    expect(latest().url).toBe('/api/stream');
    expect(latest().init?.withCredentials).toBe(true);
    latest().open();
    latest().send(JSON.stringify({ type: 'snapshot', sessions: [], machines: [], accounts: [] }));
    latest().send('깨진 JSON');
    latest().send(JSON.stringify({ hello: 1 }));
    expect(status).toEqual([true]);
    expect(messages).toEqual([{ type: 'snapshot', sessions: [], machines: [], accounts: [] }]);
  });

  it('세션 삭제(removed) 메시지도 넘긴다', () => {
    const { messages } = setup();
    latest().open();
    latest().send(JSON.stringify({ type: 'removed', sessionIds: ['a', 'b'] }));
    expect(messages).toEqual([{ type: 'removed', sessionIds: ['a', 'b'] }]);
  });

  it('브라우저가 스스로 다시 붙는 중이면 새로 만들지 않는다', () => {
    const { status } = setup();
    latest().open();
    latest().fail(false);
    vi.advanceTimersByTime(10_000);
    expect(FakeES.all).toHaveLength(1);
    expect(status).toEqual([true, false]);
  });

  it('완전히 닫히면 3초 뒤 새로 연결한다', () => {
    const { status } = setup();
    latest().open();
    latest().fail(true);
    vi.advanceTimersByTime(2_999);
    expect(FakeES.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeES.all).toHaveLength(2);
    latest().open();
    expect(status).toEqual([true, false, true]);
  });

  it('close()를 부르면 닫고 더 이상 다시 붙지 않는다', () => {
    const { close } = setup();
    const first = latest();
    first.fail(true);
    close();
    vi.advanceTimersByTime(10_000);
    expect(FakeES.all).toHaveLength(1);
    expect(first.closed).toBe(true);
  });
});
