// 비밀 값 암호화(AES-256-GCM): 텔레그램 봇 토큰, 웹 푸시 VAPID 비밀 키.
// 키는 SESSION_SECRET과 용도(purpose)에서 파생한다 — SESSION_SECRET을 바꾸면 토큰을 다시 넣어야 한다(VAPID 키는 새로 만든다).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/** 용도마다 다른 키. 기본 'telegram'은 처음부터 쓰던 키와 같다(이미 저장된 토큰이 그대로 풀린다). */
export type SecretPurpose = 'telegram' | 'push';

function keyOf(sessionSecret: string, purpose: SecretPurpose): Buffer {
  return createHash('sha256').update(`c-monitor:${purpose}:${sessionSecret}`).digest();
}

/** → 'v1:<iv>:<tag>:<암호문>'(각각 base64url) */
export function encryptSecret(plain: string, sessionSecret: string, purpose: SecretPurpose = 'telegram'): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(sessionSecret, purpose), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join(':');
}

/** 풀지 못하면(형식이 다르거나 키가 바뀜) null. */
export function decryptSecret(sealed: string, sessionSecret: string, purpose: SecretPurpose = 'telegram'): string | null {
  const [version, iv, tag, data] = sealed.split(':');
  if (version !== VERSION || !iv || !tag || data === undefined) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyOf(sessionSecret, purpose), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
