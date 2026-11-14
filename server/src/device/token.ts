// 기기 토큰과 연결 코드.
import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../util';

/** 헷갈리는 글자(0, O, 1, I)를 뺀 32글자. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 랜덤 32바이트 base64url. DB에는 hashToken() 결과만 저장한다. */
export const newToken = (): string => randomBytes(32).toString('base64url');
export const hashToken = (token: string): string => sha256Hex(token);

/** 사람이 확인하는 코드, 형식 XXXX-XXXX. */
export function newUserCode(): string {
  const bytes = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[bytes[i]! & 31];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** 사용자가 입력한 코드를 표준 형식으로(소문자·공백·하이픈 누락 허용). 형식이 아니면 null. */
export function normalizeUserCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== 8 || [...s].some((ch) => !CODE_ALPHABET.includes(ch))) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
