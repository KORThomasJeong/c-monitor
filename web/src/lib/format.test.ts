import { describe, expect, it } from 'vitest';
import { formatAgo, formatDuration, formatRemaining, formatResetLabel, normalizeUserCode } from './format';

const NOW = Date.UTC(2026, 10, 14, 1, 0, 0); // 2026-11-14 10:00 KST
const sec = (ms: number) => Math.floor(ms / 1000);

describe('formatRemaining — 초기화까지 남은 시간', () => {
  it('시간과 분을 함께 보여 준다', () => {
    expect(formatRemaining(sec(NOW) + 2 * 3600 + 13 * 60, NOW)).toBe('2시간 13분 뒤');
  });
  it('한 시간 미만이면 분만 보여 준다', () => {
    expect(formatRemaining(sec(NOW) + 47 * 60 + 30, NOW)).toBe('47분 뒤');
  });
  it('딱 떨어지는 시간은 분을 생략한다', () => {
    expect(formatRemaining(sec(NOW) + 3 * 3600, NOW)).toBe('3시간 뒤');
  });
  it('하루가 넘으면 일과 시간으로 보여 준다', () => {
    expect(formatRemaining(sec(NOW) + 2 * 86400 + 5 * 3600 + 59, NOW)).toBe('2일 5시간 뒤');
  });
  it('1분이 안 남았으면 곧이라고 한다', () => {
    expect(formatRemaining(sec(NOW) + 20, NOW)).toBe('1분 안');
  });
  it('이미 지났으면 지남', () => {
    expect(formatRemaining(sec(NOW) - 5, NOW)).toBe('지남');
    expect(formatRemaining(sec(NOW), NOW)).toBe('지남');
  });
  it('값이 없으면 알 수 없음', () => {
    expect(formatRemaining(null, NOW)).toBe('알 수 없음');
  });
});

describe('formatResetLabel — 한도 카드 아래 문구', () => {
  it('하루 안이면 남은 시간 + 초기화', () => {
    expect(formatResetLabel(sec(NOW) + 47 * 60, NOW)).toBe('47분 뒤 초기화');
  });
  it('지났거나 모르면 그렇게 말한다', () => {
    expect(formatResetLabel(sec(NOW) - 1, NOW)).toBe('초기화 시간 지남');
    expect(formatResetLabel(null, NOW)).toBe('초기화 시간 모름');
  });
  it('하루가 넘으면 요일과 시각으로 보여 준다', () => {
    expect(formatResetLabel(sec(NOW) + 3 * 86400, NOW)).toMatch(/^[월화수목금토일]요일 \d\d:\d\d 초기화$/);
  });
});

describe('formatAgo — 마지막 갱신', () => {
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  it('10초 안은 방금', () => expect(formatAgo(iso(3_000), NOW)).toBe('방금'));
  it('초·분·시간·일', () => {
    expect(formatAgo(iso(25_000), NOW)).toBe('25초 전');
    expect(formatAgo(iso(4 * 60_000), NOW)).toBe('4분 전');
    expect(formatAgo(iso(3 * 3600_000), NOW)).toBe('3시간 전');
    expect(formatAgo(iso(2 * 86400_000), NOW)).toBe('2일 전');
  });
  it('값이 없으면 기록 없음', () => expect(formatAgo(null, NOW)).toBe('기록 없음'));
});

describe('formatDuration', () => {
  it('분과 시간', () => {
    expect(formatDuration(42 * 60_000)).toBe('42분');
    expect(formatDuration(68 * 60_000)).toBe('1시간 8분');
    expect(formatDuration(30_000)).toBe('1분 미만');
  });
});

describe('normalizeUserCode — 연결 코드 다듬기', () => {
  it('소문자·공백을 정리하고 가운데 줄표를 넣는다', () => {
    expect(normalizeUserCode(' k7qm2xpa ')).toBe('K7QM-2XPA');
    expect(normalizeUserCode('K7QM-2XPA')).toBe('K7QM-2XPA');
  });
});
