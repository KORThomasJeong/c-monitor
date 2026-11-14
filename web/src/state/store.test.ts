import type { LogLine } from '@c-monitor/shared';
import { describe, expect, it } from 'vitest';
import { mkAccount, mkLine, mkMachine, mkSession } from '../test/fixtures';
import { applyMessage, emptyState, reduce, type DashboardState } from './store';

const line = (seq: number, text = `줄 ${seq}`): LogLine => mkLine(seq, { text });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => line(from + i));
/** 서버 응답 모양. 앞뒤 더 있는지는 seq로 셈한다. */
const page = (lines: LogLine[], total: number) => ({
  lines, total,
  hasMoreBefore: lines.length > 0 && lines[0]!.seq > 0,
  hasMoreAfter: lines.length > 0 && lines[lines.length - 1]!.seq < total - 1,
});
const withSessions = (...ids: string[]): DashboardState =>
  applyMessage(emptyState, { type: 'snapshot', sessions: ids.map((id) => mkSession({ id })), machines: [], accounts: [] });

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

  it('재연결 뒤 snapshot이 오면 이전 상태가 남지 않는다', () => {
    let s = applyMessage(emptyState, {
      type: 'snapshot',
      sessions: [mkSession({ id: 'a' }), mkSession({ id: 'gone' })],
      machines: [mkMachine({ id: 'm1' }), mkMachine({ id: 'm-gone' })],
      accounts: [mkAccount({ email: 'gone@a.com' })],
    });
    s = applyMessage(s, { type: 'session', session: mkSession({ id: 'extra' }) });
    s = reduce(s, { type: 'logPage', sessionId: 'a', kind: 'latest', res: page([line(0)], 1) });
    s = reduce(s, { type: 'logPage', sessionId: 'gone', kind: 'latest', res: page([line(0)], 1) });

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
    expect(s.logs.a?.lines.map((l) => l.seq)).toEqual([0]);
  });

  it('입력 상태를 바꾸지 않는다(순수 함수)', () => {
    const before = applyMessage(emptyState, { type: 'snapshot', sessions: [mkSession({ id: 'a' })], machines: [], accounts: [] });
    const frozen = JSON.stringify(before);
    applyMessage(before, { type: 'session', session: mkSession({ id: 'a', status: 'end' }) });
    applyMessage(before, { type: 'log', sessionId: 'a', lines: [line(0)] });
    applyMessage(before, { type: 'removed', sessionIds: ['a'] });
    expect(JSON.stringify(before)).toBe(frozen);
  });
});

describe('대화 창(페이지 단위)', () => {
  it('처음엔 최근 줄만 담고 전체 수와 앞쪽이 더 있는지를 기억한다', () => {
    const s = reduce(withSessions('a'), { type: 'logPage', sessionId: 'a', kind: 'latest', res: page(range(489, 588), 589) });
    expect(s.logs.a).toMatchObject({ total: 589, hasMoreBefore: true, hasMoreAfter: false, fresh: 0, loading: false });
    expect(s.logs.a?.lines).toHaveLength(100);
  });

  it('이전 대화를 앞에 붙이고, 뒤쪽 상태는 그대로 둔다', () => {
    let s = reduce(withSessions('a'), { type: 'logPage', sessionId: 'a', kind: 'latest', res: page(range(489, 588), 589) });
    s = reduce(s, { type: 'logPage', sessionId: 'a', kind: 'before', res: page(range(389, 488), 589) });
    expect(s.logs.a?.lines.map((l) => l.seq).slice(0, 2)).toEqual([389, 390]);
    expect(s.logs.a?.lines).toHaveLength(200);
    expect(s.logs.a).toMatchObject({ hasMoreBefore: true, hasMoreAfter: false });
  });

  it('최신에 붙어 있으면 실시간 줄을 뒤에 붙이고 전체 수를 늘린다', () => {
    let s = reduce(withSessions('a'), { type: 'logPage', sessionId: 'a', kind: 'latest', res: page(range(0, 9), 10) });
    s = applyMessage(s, { type: 'log', sessionId: 'a', lines: [line(9, '중복'), line(10), line(11)] });
    expect(s.logs.a?.lines.map((l) => l.seq).slice(-3)).toEqual([9, 10, 11]);
    expect(s.logs.a?.lines[9]?.text).toBe('줄 9');
    expect(s.logs.a).toMatchObject({ total: 12, fresh: 0 });
  });

  it('과거를 보는 중이면 실시간 줄을 붙이지 않고 새 줄 수만 센다', () => {
    let s = reduce(withSessions('a'), { type: 'logPage', sessionId: 'a', kind: 'around', res: page(range(100, 199), 589) });
    s = applyMessage(s, { type: 'log', sessionId: 'a', lines: [line(589), line(590)] });
    expect(s.logs.a?.lines.map((l) => l.seq).at(-1)).toBe(199);
    expect(s.logs.a).toMatchObject({ total: 591, fresh: 2, hasMoreAfter: true });
    // 최신으로 돌아가면 센 수는 지운다.
    s = reduce(s, { type: 'logPage', sessionId: 'a', kind: 'latest', res: page(range(491, 590), 591) });
    expect(s.logs.a).toMatchObject({ fresh: 0, hasMoreAfter: false });
  });

  it('불러오는 동안 온 줄은 응답 뒤에도 남는다', () => {
    let s = reduce(withSessions('a'), { type: 'logLoading', sessionId: 'a' });
    expect(s.logs.a).toMatchObject({ loading: true, lines: [] });
    s = applyMessage(s, { type: 'log', sessionId: 'a', lines: [line(5)] });
    s = reduce(s, { type: 'logPage', sessionId: 'a', kind: 'latest', res: page(range(0, 4), 5) });
    expect(s.logs.a?.lines.map((l) => l.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(s.logs.a?.total).toBe(6);
  });

  it('열어 보지 않은 세션의 실시간 줄은 담지 않는다', () => {
    const s = applyMessage(withSessions('a'), { type: 'log', sessionId: 'a', lines: [line(0)] });
    expect(s.logs.a).toBeUndefined();
  });

  it('빠진 줄 채우기(after)는 뒤에 붙이고 뒤쪽 상태를 응답대로 바꾼다', () => {
    let s = reduce(withSessions('a'), { type: 'logPage', sessionId: 'a', kind: 'latest', res: page(range(0, 9), 10) });
    s = reduce(s, { type: 'logPage', sessionId: 'a', kind: 'after', res: page(range(10, 14), 15) });
    expect(s.logs.a?.lines.map((l) => l.seq).at(-1)).toBe(14);
    expect(s.logs.a).toMatchObject({ total: 15, hasMoreAfter: false });
  });

  it('불러오지 못하면 빈 창으로 둔다(불러오는 중에 머물지 않음)', () => {
    let s = reduce(withSessions('a'), { type: 'logLoading', sessionId: 'a' });
    s = reduce(s, { type: 'logFailed', sessionId: 'a' });
    expect(s.logs.a).toMatchObject({ loading: false, lines: [] });
  });
});

describe('세션 지우기', () => {
  it('removed는 세션과 불러 둔 대화를 없앤다', () => {
    let s = withSessions('a', 'b');
    s = reduce(s, { type: 'logPage', sessionId: 'a', kind: 'latest', res: page([line(0)], 1) });
    s = applyMessage(s, { type: 'removed', sessionIds: ['a'] });
    expect(s.sessions.map((x) => x.id)).toEqual(['b']);
    expect(s.logs.a).toBeUndefined();
  });

  it('restore는 지운 세션을 제자리에 되돌린다', () => {
    let s = withSessions('a', 'b', 'c');
    const b = s.sessions[1]!;
    s = reduce(s, { type: 'logPage', sessionId: 'b', kind: 'latest', res: page([line(0)], 1) });
    const log = s.logs.b;
    s = applyMessage(s, { type: 'removed', sessionIds: ['b'] });
    s = reduce(s, { type: 'restore', session: b, log, index: 1 });
    expect(s.sessions.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(s.logs.b?.lines).toHaveLength(1);
    // 이미 다시 들어와 있으면(스냅샷 등) 겹치지 않는다.
    s = reduce(s, { type: 'restore', session: b, log, index: 1 });
    expect(s.sessions.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});
