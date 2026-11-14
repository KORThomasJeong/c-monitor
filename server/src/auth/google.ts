// 구글 OAuth(인가 코드 + PKCE)를 fetch로 직접 호출한다.
import { createHash } from 'node:crypto';
import type { Config, GoogleClient } from '../types';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export function redirectUri(config: Pick<Config, 'publicUrl'>): string {
  return `${config.publicUrl}/auth/google/callback`;
}

export function pkceChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

export function createGoogleClient(
  config: Pick<Config, 'publicUrl' | 'googleClientId' | 'googleClientSecret'>,
  fetchFn: typeof fetch = fetch,
): GoogleClient {
  return {
    authUrl(state, codeVerifier) {
      const q = new URLSearchParams({
        client_id: config.googleClientId,
        redirect_uri: redirectUri(config),
        response_type: 'code',
        scope: 'openid email profile',
        state,
        code_challenge: pkceChallenge(codeVerifier),
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      return `${AUTH_URL}?${q.toString()}`;
    },

    async exchange(code, codeVerifier) {
      const tokenRes = await fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.googleClientId,
          client_secret: config.googleClientSecret,
          redirect_uri: redirectUri(config),
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!tokenRes.ok) throw new Error(`구글 토큰 교환 실패(${tokenRes.status})`);
      const token = (await tokenRes.json()) as { access_token?: string };
      if (!token.access_token) throw new Error('구글 응답에 access_token이 없습니다');

      const infoRes = await fetchFn(USERINFO_URL, {
        headers: { authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!infoRes.ok) throw new Error(`구글 사용자 정보 조회 실패(${infoRes.status})`);
      const info = (await infoRes.json()) as { email?: string; email_verified?: boolean | string; name?: string };
      const verified = info.email_verified === true || info.email_verified === 'true';
      if (!info.email || !verified) throw new Error('확인된 구글 이메일이 없습니다');
      return { email: info.email, name: info.name ?? null };
    },
  };
}
