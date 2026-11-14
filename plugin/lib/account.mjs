// 지금 로그인된 클로드 계정 이메일. 매 이벤트마다 다시 읽으므로 계정 전환(cswap)도 바로 반영된다.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './config.mjs';

/** 기본은 ~/.claude.json, CLAUDE_CONFIG_DIR가 있으면 그 안의 .claude.json. */
export function claudeJsonPath() {
  return process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : join(homedir(), '.claude.json');
}

/** oauthAccount.emailAddress. 읽지 못하면 null. */
export function readAccount() {
  const email = readJson(claudeJsonPath())?.oauthAccount?.emailAddress;
  return typeof email === 'string' && email.length > 0 ? email.slice(0, 320) : null;
}
