import type { LogLine } from '@c-monitor/shared';
import { describe, expect, it } from 'vitest';
import { mkAccount, mkLine, mkMachine, mkSession } from '../test/fixtures';
import { applyMessage, emptyState } from './store';

const line = (seq: number, text = `줄 ${seq}`): LogLine => mkLine(seq, { text });

describe('applyMessage', () => {
  it('snapshot은 세션·컴퓨터·계정을 통째로 바꾼다', () => {
    const s = applyMessage(emptyState, {
      type: 'snapshot',
      sessions: [mkSession({ id: 'a' })],
      machines: [mkMachine({ id: 'm1' })],
      accounts: [mkAccount({ email: 'dev@company-a.example' })],
    });
    expect(s.loaded).toBe(true);
    expect(s.sessions.map((x) => x.id)).toEqual(['a']);
    expect(s.machines).toHaveLength(1);
    expect(s.accounts).toHaveLength(1);
  });

  it('session은 id 기준으로 고치거나 새로 넣는다', () => {
    let s = applyMessage(emptyState, { type: 'snapshot', sessions: [mkSession({ id: 'a' })], machines: [], accounts: [] });
    s = applyMessage(s, { type: 'session', session: mkSession({ id: 'a', status: 'wait', seen: false }) });
    s = applyMessage(s, { type: 'session', session: mkSession({ id: 'b' }) });
    expect(s.sessions.map((x) => [x.id, x.status])).toEqual([['a', 'wait'], ['b', 'run']]);
  });

  it('machine은 id, limits는 email 기준으로 고치거나 넣는다', () => {
    let s = applyMessage(emptyState, {
      type: 'snapshot', sessions: [], machines: [mkMachine({ id: 'm1' })], accounts: [mkAccount({ email: 'x@a.com' })],
    });
    s = applyMessage(s, { type: 'machine', machine: mkMachine({ id: 'm1', online: false }) });
    s = applyMessage(s, { type: 'machine', machine: mkMachine({ id: 'm2' }) });
    s = applyMessage(s, { type: 'limits', account: mkAccount({ email: 'x@a.com', fiveHourPct: 90 }) });
    s = applyMessage(s, { type: 'limits', account: mkAccount({ email: 'y@a.com' }) });
    expect(s.machines.map((m) => [m.id, m.online])).toEqual([['m1', false], ['m2', true]]);
    expect(s.accounts.map((a) => [a.email, a.fiveHourPct])).toEqual([['x@a.com', 90], ['y@a.com', 10]]);
  });

  it('log는 seq 기준으로 중복 없이 순서대로 이어 붙인다', () => {
    let s = applyMessage(emptyState, { type: 'log', sessionId: 'a', lines: [line(0), line(1), line(2)] });
    s = applyMessage(s, { type: 'log', sessionId: 'a', lines: [line(2, '다시 온 줄'), line(3)] });
    // 빠졌던 줄이 나중에 와도 제자리에 들어간다.
    s = applyMessage(s, { type: 'log', sessionId: 'a', lines: [line(6), line(5)] });
    s = applyMessage(s, { type: 'log', sessionId: 'a', lines: [line(4)] });
    expect(s.logs.a?.map((l) => l.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(s.logs.a?.[2]?.text).toBe('줄 2');
  });

  it('다른 세션의 로그는 섞이지 않는다', () => {
    let s = applyMessage(emptyState, { type: 'log', sessionId: 'a', lines: [line(0)] });
    s = applyMessage(s, { type: 'log', sessionId: 'b', lines: [line(0), line(1)] });
    expect(s.logs.a).toHaveLength(1);
    expect(s.logs.b).toHaveLength(2);
  });

  it('재연결 뒤 snapshot이 오면 이전 상태가 남지 않는다', () => {
    let s = applyMessage(emptyState, {
      type: 'snapshot',
      sessions: [mkSession({ id: 'a' }), mkSession({ id: 'gone' })],
      machines: [mkMachine({ id: 'm1' }), mkMachine({ id: 'm-gone' })],
      accounts: [mkAccount({ email: 'gone@a.com' })],
    });
    s = applyMessage(s, { type: 'session', session: mkSession({ id: 'extra' }) });
    s = applyMessage(s, { type: 'log', sessionId: 'a', lines: [line(0)] });
    s = applyMessage(s, { type: 'log', sessionId: 'gone', lines: [line(0)] });

    s = applyMessage(s, {
      type: 'snapshot',
      sessions: [mkSession({ id: 'a', status: 'done' })],
      machines: [mkMachine({ id: 'm1' })],
      accounts: [],
    });
    expect(s.sessions.map((x) => [x.id, x.status])).toEqual([['a', 'done']]);
    expect(s.machines.map((m) => m.id)).toEqual(['m1']);
    expect(s.accounts).toEqual([]);
    // 사라진 세션의 로그는 버리고, 남은 세션의 로그는 이어 붙일 수 있게 둔다.
    expect(s.logs.gone).toBeUndefined();
    expect(s.logs.a?.map((l) => l.seq)).toEqual([0]);
  });

  it('입력 상태를 바꾸지 않는다(순수 함수)', () => {
    const before = applyMessage(emptyState, { type: 'snapshot', sessions: [mkSession({ id: 'a' })], machines: [], accounts: [] });
    const frozen = JSON.stringify(before);
    applyMessage(before, { type: 'session', session: mkSession({ id: 'a', status: 'end' }) });
    applyMessage(before, { type: 'log', sessionId: 'a', lines: [line(0)] });
    expect(JSON.stringify(before)).toBe(frozen);
  });
});
