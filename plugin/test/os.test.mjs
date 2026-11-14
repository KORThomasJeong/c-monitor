// 운영체제 표기: 연결·훅·상태줄 래퍼가 모두 같은 값을 보내야 서버의 표시가 바뀌지 않는다.
import { describe, expect, it } from 'vitest';
import { osLabel } from '../lib/os.mjs';

describe('osLabel', () => {
  it('플랫폼 이름을 사람이 읽는 이름으로 바꾸고 버전을 붙인다', () => {
    expect(osLabel('win32', '10.0.26200')).toBe('Windows 10.0.26200');
    expect(osLabel('darwin', '24.1.0')).toBe('macOS 24.1.0');
    expect(osLabel('linux', '6.8.0-48-generic')).toBe('Linux 6.8.0-48-generic');
  });

  it('모르는 플랫폼은 이름 그대로, 100자를 넘지 않는다', () => {
    expect(osLabel('freebsd', '14.1')).toBe('freebsd 14.1');
    expect(osLabel('linux', 'x'.repeat(300)).length).toBe(100);
  });

  it('인자가 없으면 지금 컴퓨터의 값을 쓴다', () => {
    expect(osLabel()).toMatch(/^\S+ \S/);
    expect(osLabel()).not.toMatch(/^(win32|darwin|linux) /);
  });
});
