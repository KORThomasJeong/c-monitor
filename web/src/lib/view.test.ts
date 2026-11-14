import { describe, expect, it } from 'vitest';
import { mkLine } from '../test/fixtures';
import { canDelete, isPcOs, splitMatches, toolText } from './view';

describe('isPcOs', () => {
  it('Windows·macOS는 표기가 달라도 PC로 본다', () => {
    for (const os of ['Windows 11', 'win32', 'Win64', 'Windows_NT 10.0.26100', 'darwin', 'Darwin 24.1.0', 'macOS 15', 'Mac OS X']) {
      expect(isPcOs(os), os).toBe(true);
    }
  });
  it('리눅스 등은 서버로 본다', () => {
    for (const os of ['linux', 'Ubuntu 24.04', 'Linux 6.8.0', 'Debian 12', 'freebsd', '']) {
      expect(isPcOs(os), os).toBe(false);
    }
  });
});

describe('canDelete', () => {
  it('종료·연락 끊김만 지울 수 있다', () => {
    expect(canDelete('end')).toBe(true);
    expect(canDelete('lost')).toBe(true);
    for (const s of ['run', 'wait', 'done', 'limit'] as const) expect(canDelete(s)).toBe(false);
  });
});

describe('splitMatches', () => {
  it('찾은 글자를 대소문자 없이 조각으로 나눈다', () => {
    expect(splitMatches('Git push origin; git PUSH', 'push')).toEqual([
      { text: 'Git ', hit: false }, { text: 'push', hit: true }, { text: ' origin; git ', hit: false }, { text: 'PUSH', hit: true },
    ]);
  });
  it('정규식 특수문자도 글자 그대로 찾는다', () => {
    expect(splitMatches('a.b(c)', '.b(')).toEqual([{ text: 'a', hit: false }, { text: '.b(', hit: true }, { text: 'c)', hit: false }]);
  });
  it('검색어가 없거나 2자 미만이면 통째로 돌려준다', () => {
    expect(splitMatches('abc', '')).toEqual([{ text: 'abc', hit: false }]);
    expect(splitMatches('abc', 'a')).toEqual([{ text: 'abc', hit: false }]);
  });
});

describe('toolText', () => {
  it('본문이 있으면 본문을 쓰고 입력을 덧붙이지 않는다', () => {
    const t = toolText(mkLine(0, { role: 'tool', toolName: 'Bash', text: 'npm test', toolInput: { command: 'npm test' } }));
    expect(t).toEqual({ head: 'npm test', rest: '' });
  });
  it('본문이 없으면 입력을 요약한다', () => {
    expect(toolText(mkLine(0, { role: 'tool', text: '', toolInput: { command: 'cat .env' } }))).toEqual({ head: 'cat .env', rest: '' });
  });
  it('여러 줄이면 첫 줄과 나머지로 나눈다', () => {
    const t = toolText(mkLine(0, { role: 'tool', text: '\n ✓ a.test.ts\n ✓ b.test.ts\n' }));
    expect(t.head).toBe('✓ a.test.ts');
    expect(t.rest).toBe(' ✓ a.test.ts\n ✓ b.test.ts');
  });
});
