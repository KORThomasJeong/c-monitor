import { describe, expect, it } from 'vitest';
import { maskDeep, maskSecrets } from '../lib/mask.mjs';

const DOTS = '••••••••';
// 가짜 키는 실행 중에 이어 붙여 만든다(공개 저장소의 비밀 검사에 걸리지 않게).
const fake = {
  skAnt: 'sk-' + 'ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4',
  sk: 'sk-' + 'proj' + 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2',
  ghp: 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
  gho: 'gh' + 'o_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
  pat: 'github' + '_pat_' + '11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789',
  akia: 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP',
  xoxb: 'xo' + 'xb-' + '1234567890-abcdefghijklmnop',
  xoxp: 'xo' + 'xp-' + '1234567890-abcdefghijklmnop',
  aiza: 'AI' + 'za' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q',
  // 구글 OAuth 클라이언트 보안 비밀과 액세스 토큰
  gocspx: 'GOC' + 'SPX-' + 'a1B2c3D4e5F6g7H8i-J0k1L2m3N4',
  ya29: 'ya' + '29.' + 'a0AfH6SMBx1y2Z3a4B5c6D7e8F9g0H_i-J',
  jwt: 'ey' + 'JhbGciOiJIUzI1NiJ9' + '.' + 'ey' + 'JzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
};

describe('maskSecrets', () => {
  it.each(Object.entries(fake))('%s 모양을 가린다', (_name, secret) => {
    const r = maskSecrets(`앞 글 ${secret} 뒤 글`);
    expect(r.text).toBe(`앞 글 ${DOTS} 뒤 글`);
    expect(r.count).toBe(1);
  });

  it('Bearer 토큰은 Bearer 글자는 남기고 값만 가린다', () => {
    const r = maskSecrets('Authorization: Bearer abcDEF123456789xyz');
    expect(r.text).toBe(`Authorization: Bearer ${DOTS}`);
    expect(r.count).toBe(1);
  });

  it.each(['password', 'passwd', 'secret', 'token', 'api_key', 'apikey'])('%s= 뒤의 값을 가린다', (key) => {
    const r = maskSecrets(`curl "https://x.test/?${key}=hunter2&next=1"`);
    expect(r.text).toBe(`curl "https://x.test/?${key}=${DOTS}&next=1"`);
    expect(r.count).toBe(1);
  });

  it('대문자·접두어가 붙은 키와 따옴표 값도 가린다', () => {
    const r = maskSecrets('DB_PASSWORD="p@ss word!" API_KEY=abc123');
    expect(r.text).toBe(`DB_PASSWORD=${DOTS} API_KEY=${DOTS}`);
    expect(r.count).toBe(2);
  });

  it('개인 키 블록을 통째로 가린다', () => {
    const block = ['-----BEGIN RSA ' + 'PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7', '-----END RSA ' + 'PRIVATE KEY-----'].join('\r\n');
    const r = maskSecrets(`키:\n${block}\n끝`);
    expect(r.text).toBe(`키:\n${DOTS}\n끝`);
    expect(r.count).toBe(1);
  });

  it('여러 개가 섞여 있으면 개수를 모두 센다', () => {
    const r = maskSecrets(`${fake.ghp} 와 ${fake.akia} 그리고 token=${fake.sk}`);
    expect(r.count).toBe(3);
    expect(r.text).not.toContain(fake.ghp);
    expect(r.text).not.toContain(fake.akia);
    expect(r.text).not.toContain(fake.sk);
  });

  it('평범한 문장과 짧은 sk- 단어는 건드리지 않는다', () => {
    const plain = [
      '오늘은 서버 배포를 마치고 테스트를 돌렸습니다.',
      'The quick brown fox jumps over the lazy dog.',
      'sk-ecoplant 계정으로 로그인했습니다. task-runner, risk-free, AKIA 라는 단어.',
      '토큰 사용량과 password 정책에 대해 이야기했습니다. Bearer 방식 인증.',
      'const token = getToken(); if (a == b) return;',
      'C:\\work\\x\\src\\index.ts 파일을 고쳤습니다. eyJ 로 시작하는 글자.',
    ];
    for (const s of plain) {
      const r = maskSecrets(s);
      expect(r.text).toBe(s);
      expect(r.count).toBe(0);
    }
  });

  it('문자열이 아니면 빈 글로 다룬다', () => {
    expect(maskSecrets(undefined)).toEqual({ text: '', count: 0 });
  });
});

describe('maskDeep', () => {
  it('객체·배열 안의 문자열을 모두 가리고 개수를 합친다', () => {
    const input = {
      command: `curl -H "Authorization: Bearer abcDEF123456789xyz" https://x.test`,
      nested: { list: [fake.ghp, 42, null, true], note: '평범한 글' },
    };
    const r = maskDeep(input);
    expect(r.count).toBe(2);
    expect(r.value.command).toContain(`Bearer ${DOTS}`);
    expect(r.value.nested.list).toEqual([DOTS, 42, null, true]);
    expect(r.value.nested.note).toBe('평범한 글');
    // 원본은 바꾸지 않는다.
    expect(input.nested.list[0]).toBe(fake.ghp);
  });

  it('이름이 비밀번호류인 키의 값은 모양과 상관없이 가린다', () => {
    const r = maskDeep({ password: 'hunter2', apiKey: 'abc', user: 'kim' });
    expect(r.value).toEqual({ password: DOTS, apiKey: DOTS, user: 'kim' });
    expect(r.count).toBe(2);
  });
});
