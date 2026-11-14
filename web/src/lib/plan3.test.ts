import type { ReplyRecord, StreamMessage } from '@c-monitor/shared';
import { describe, expect, it } from 'vitest';
import { emptyState, mergeReplies, reduce } from '../state/store';
import { mkLine, mkSession } from '../test/fixtures';
import { formatBytes, formatQuota, formatUsd } from './format';
import { browserLabel, urlBase64ToUint8Array } from './push';
import { chimeFor } from './sound';
import { ctxText, interleave, replyText, roParticle } from './view';

const rec = (id: string, at: string, o: Partial<ReplyRecord> = {}): ReplyRecord => ({
  id, at, source: 'web', kind: 'permission', label: '허용', ...o,
});

describe('답 기록 문구', () => {
  it('받침에 따라 "로/으로"를 고른다(ㄹ 받침은 "로")', () => {
    expect(roParticle('허용')).toBe('으로');
    expect(roParticle('거부')).toBe('로');
    expect(roParticle('이 세션 동안 허용')).toBe('으로');
    expect(roParticle('파일')).toBe('로');
    expect(roParticle('A')).toBe('로');
  });

  it('웹·텔레그램, 답·글을 나눠 한 줄로 쓴다', () => {
    expect(replyText(rec('1', '2026-11-14T00:00:00Z'))).toBe('웹에서 「허용」으로 답했습니다');
    expect(replyText(rec('2', '2026-11-14T00:00:00Z', { source: 'telegram', label: '거부' }))).toBe('텔레그램에서 「거부」로 답했습니다');
    expect(replyText(rec('3', '2026-11-14T00:00:00Z', { kind: 'message', label: '테스트도 돌려 주세요' })))
      .toBe('웹에서 글을 보냈습니다 「테스트도 돌려 주세요」');
  });
});

describe('대화 줄 사이에 답 기록 끼우기', () => {
  const lines = [
    mkLine(0, { at: '2026-11-14T00:00:00Z' }),
    mkLine(1, { at: '2026-11-14T00:02:00Z' }),
    mkLine(2, { at: '2026-11-14T00:04:00Z' }),
  ];
  const kinds = (items: ReturnType<typeof interleave>) => items.map((i) => (i.kind === 'line' ? `L${i.line.seq}` : `R${i.reply.id}`));

  it('시각 순으로 끼우고, 같은 시각이면 줄 뒤에 둔다', () => {
    const items = interleave(lines, [rec('b', '2026-11-14T00:03:00Z'), rec('a', '2026-11-14T00:02:00Z'), rec('c', '2026-11-14T00:09:00Z')],
      { hasMoreBefore: false, hasMoreAfter: false });
    expect(kinds(items)).toEqual(['L0', 'L1', 'Ra', 'Rb', 'L2', 'Rc']);
  });

  it('불러온 범위 밖 기록은 뺀다', () => {
    const items = interleave(lines, [rec('old', '2026-11-13T23:00:00Z'), rec('new', '2026-11-14T01:00:00Z')],
      { hasMoreBefore: true, hasMoreAfter: true });
    expect(kinds(items)).toEqual(['L0', 'L1', 'L2']);
  });
});

describe('표시 함수', () => {
  it('용량·한도·비용·컨텍스트', () => {
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(1536)).toBe('1.5KB');
    expect(formatBytes(418 * 1024 * 1024)).toBe('418MB');
    expect(formatBytes(29 * 1024 ** 3)).toBe('29GB');
    expect(formatQuota(0)).toBe('무제한');
    expect(formatQuota(1024)).toBe('1GB');
    expect(formatUsd(3.1234)).toBe('$3.12');
    expect(ctxText(63.6)).toBe('64%');
    expect(ctxText(null)).toBeNull();
  });

  it('브라우저 이름', () => {
    expect(browserLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toBe('Chrome · Windows');
    expect(browserLabel('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('Edge · Windows');
    expect(browserLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Gecko/20100101 Firefox/131.0')).toBe('Firefox · macOS');
    expect(browserLabel('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36')).toBe('Chrome · Android');
  });

  it('VAPID 공개 키(base64url)를 바이트로', () => {
    expect([...urlBase64ToUint8Array('AQID_-8')]).toEqual([1, 2, 3, 255, 239]);
  });
});

describe('웹 알림 소리 고르기', () => {
  it('wait·done으로 바뀐 세션만 울리고 wait가 앞선다', () => {
    const prev = new Map([['a', 'run'], ['b', 'run'], ['c', 'wait']]);
    expect(chimeFor(prev, [{ id: 'a', status: 'done' }, { id: 'b', status: 'run' }])).toBe('done');
    expect(chimeFor(prev, [{ id: 'a', status: 'done' }, { id: 'b', status: 'wait' }])).toBe('wait');
    // 이미 wait였던 세션, 처음 보는 세션은 울리지 않는다.
    expect(chimeFor(prev, [{ id: 'c', status: 'wait' }, { id: 'z', status: 'wait' }])).toBeNull();
  });
});

describe('스토어: 답 기록·기록 탭', () => {
  const snap: StreamMessage = { type: 'snapshot', sessions: [mkSession({ id: 's1' })], machines: [], accounts: [] };

  it('스트림 reply는 id로 합치고 시각 순으로 둔다', () => {
    let s = reduce(emptyState, snap);
    s = reduce(s, { type: 'reply', sessionId: 's1', reply: rec('2', '2026-11-14T00:05:00Z') });
    s = reduce(s, { type: 'reply', sessionId: 's1', reply: rec('1', '2026-11-14T00:01:00Z') });
    s = reduce(s, { type: 'reply', sessionId: 's1', reply: rec('2', '2026-11-14T00:05:00Z', { label: '거부' }) });
    expect(s.replies.s1!.map((r) => `${r.id}:${r.label}`)).toEqual(['1:허용', '2:거부']);
    expect(mergeReplies(undefined, [])).toEqual([]);
  });

  it('기록 탭 세션의 대화도 받아 두고, 지우면 기록에서도 빠진다', () => {
    let s = reduce(emptyState, snap);
    s = reduce(s, { type: 'history', sessions: [mkSession({ id: 'old', status: 'end' })], machines: [] });
    s = reduce(s, { type: 'logPage', sessionId: 'old', kind: 'latest', res: { lines: [mkLine(0)], total: 1, hasMoreBefore: false, hasMoreAfter: false } });
    expect(s.logs.old!.lines).toHaveLength(1);
    // 새 스냅샷이 와도 기록 탭 세션의 대화는 남는다.
    s = reduce(s, snap);
    expect(s.logs.old).toBeDefined();
    s = reduce(s, { type: 'removed', sessionIds: ['old'] });
    expect(s.history).toEqual([]);
    expect(s.logs.old).toBeUndefined();
  });
});
