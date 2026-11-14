#!/usr/bin/env node
// PermissionRequest 훅(동기). 승인·선택지 질문을 서버에 등록하고, 웹에서 답이 오면 그 결정을 클로드코드에 돌려준다.
//
// 터미널이 항상 우선이다. 이 훅이 도는 동안에도 터미널의 승인 창은 그대로 떠 있다.
// 그래서 문제가 있으면(연결 전·서버 꺼짐·원격 답장 꺼짐·터미널에서 먼저 답함) 아무것도 출력하지 않고 0으로 끝난다
// — 그러면 평소처럼 터미널에서 답하면 된다. stdout에는 결정 JSON 한 줄 말고는 아무것도 쓰지 않는다.
import { loadConfig } from '../lib/config.mjs';
import { watchParent } from '../lib/parent.mjs';
import { buildAsk, buildDecision } from '../lib/reply.mjs';
import { postJson } from '../lib/send.mjs';
import { readStdin, sleep, tuneMs } from '../lib/stdin.mjs';

/** 등록에 쓰는 시간. 서버가 꺼져 있거나 느려도 이보다 오래 붙잡지 않는다. */
const REGISTER_TIMEOUT_MS = 3000;
/** 대기 요청 하나의 제한시간. 서버가 붙잡는 시간(REPLY_POLL_SECONDS = 25초)보다 넉넉하게. */
const WAIT_TIMEOUT_MS = 35_000;
/** 연속으로 이만큼 실패하면 포기한다(터미널에 맡긴다). */
const MAX_FAILS = 5;
/** 전체 상한. hooks.json 의 timeout(12시간)보다 조금 짧게 잡아 스스로 끝난다. */
const TOTAL_MS = 12 * 3600 * 1000 - 60_000;

/** → 클로드코드에 돌려줄 출력 객체, 없으면 null */
async function main() {
  const raw = await readStdin();
  const cfg = loadConfig();
  if (!cfg || cfg.revokedAt) return null; // 연결 전이거나 서버에서 연결을 해제했다

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }
  const ask = buildAsk(input);
  if (!ask) return null;

  const base = cfg.server.replace(/\/+$/, '');
  const reg = await postJson(`${base}/api/reply/ask`, ask.body, cfg.token, REGISTER_TIMEOUT_MS);
  // {disabled:true}(이 컴퓨터의 원격 답장이 꺼짐)·실패·옛 서버(404)는 모두 조용히 끝낸다.
  const requestId = reg.ok && reg.json && reg.json.disabled !== true ? reg.json.requestId : null;
  if (typeof requestId !== 'string' || requestId.length === 0) return null;

  // 클로드코드가 죽으면 같이 끝난다(서버가 이 요청을 살아 있다고 여기지 않게).
  watchParent(() => process.exit(0));

  const until = Date.now() + TOTAL_MS;
  const retryMs = tuneMs('RETRY', 2000);
  const minPollMs = tuneMs('MIN_POLL', 1000);
  let fails = 0;
  while (Date.now() < until) {
    const started = Date.now();
    const r = await postJson(`${base}/api/reply/wait`, { requestId }, cfg.token, WAIT_TIMEOUT_MS);
    const status = r.ok && r.json ? r.json.status : null;
    if (status === 'answered') return buildDecision(input, ask, r.json.answer);
    if (status === 'gone') return null; // 터미널에서 먼저 답했거나 만료·삭제됨
    if (status === 'pending') {
      fails = 0;
      // 서버가 붙잡지 않고 바로 돌려주더라도 쉴 새 없이 묻지 않는다.
      const spent = Date.now() - started;
      if (spent < minPollMs) await sleep(minPollMs - spent);
      continue;
    }
    // 다시 해도 같은 거절(요청을 모름·연결 해제·사용자 정지 등)이면 끝낸다.
    if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) return null;
    // 네트워크 오류·5xx: 잠깐 쉬고 다시.
    fails += 1;
    if (fails >= MAX_FAILS) return null;
    await sleep(retryMs);
  }
  return null;
}

const quit = () => process.exit(0);
process.on('uncaughtException', quit);
process.on('unhandledRejection', quit);
// stdout이 이미 닫혔으면(터미널에서 먼저 답해 클로드코드가 출력을 버림) 조용히 끝낸다.
process.stdout.on('error', quit);

main().then((output) => {
  if (!output) return quit();
  // 다 쓴 뒤에 끝낸다(파이프에 쓰는 도중에 끝나면 출력이 잘린다).
  process.stdout.write(JSON.stringify(output) + '\n', quit);
}).catch(quit);
