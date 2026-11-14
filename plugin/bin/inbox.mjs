#!/usr/bin/env node
// Stop·SessionStart 훅(async + asyncRewake). 멈춰 있는 세션 옆에서 서버에 "보낸 글이 있는지" 묻고 있다가,
// 웹에서 글이 오면 stderr에 쓰고, 다 쓴 뒤 서버에 수신 확인(ack)을 보내고 종료 코드 2로 끝난다
// — 클로드코드가 그 글을 받아 세션을 다시 움직인다. ack가 실패해도 종료 코드는 2다(서버가 60초 뒤 다시 줄 수 있다).
// 그 밖의 모든 경우(연결 전·해제·원격 답장 꺼짐·새 대기자가 붙음·클로드코드 종료)는 아무것도 쓰지 않고 0으로 끝난다.
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../lib/config.mjs';
import { watchParent } from '../lib/parent.mjs';
import { wakeText } from '../lib/reply.mjs';
import { postJson } from '../lib/send.mjs';
import { readStdin, sleep, tuneMs } from '../lib/stdin.mjs';

/** 요청 하나의 제한시간. 서버가 붙잡는 시간(REPLY_POLL_SECONDS = 25초)보다 넉넉하게. */
const POLL_TIMEOUT_MS = 35_000;
/** 다시 시도하기 전에 쉬는 시간의 상한 */
const MAX_RETRY_MS = 60_000;
/** 404가 연속으로 이만큼 오면 포기한다(원격 답장이 없는 옛 서버). */
const MAX_NOT_FOUND = 5;
/** 전체 상한. hooks.json 의 timeout(24시간)보다 조금 짧게 잡아 스스로 끝난다. */
const TOTAL_MS = 24 * 3600 * 1000 - 60_000;
/** 수신 확인(ack) 요청의 제한시간 */
const ACK_TIMEOUT_MS = 3000;

/** → 세션에 전할 글과 수신 확인에 쓸 값({ text, ack }), 없으면 null */
async function main() {
  const raw = await readStdin();
  const cfg = loadConfig();
  if (!cfg || cfg.revokedAt) return null;

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }
  const sessionId = input && typeof input === 'object' && typeof input.session_id === 'string' ? input.session_id.slice(0, 200) : '';
  if (sessionId.length === 0) return null;

  // 이 프로세스의 이름표. 같은 세션에 새 대기자가 붙으면 서버가 옛 대기자에게 gone 을 준다.
  const waiterId = randomUUID();
  // 클로드코드가 죽으면 같이 끝난다(고아 프로세스로 남지 않게).
  watchParent(() => process.exit(0));

  const url = `${cfg.server.replace(/\/+$/, '')}/api/reply/inbox`;
  const until = Date.now() + TOTAL_MS;
  const retryMs = tuneMs('RETRY', 2000);
  const minPollMs = tuneMs('MIN_POLL', 1000);
  let delay = retryMs;
  let notFound = 0;
  while (Date.now() < until) {
    const started = Date.now();
    const r = await postJson(url, { sessionId, waiterId }, cfg.token, POLL_TIMEOUT_MS);
    const status = r.ok && r.json ? r.json.status : null;
    if (status === 'message' && typeof r.json.text === 'string' && r.json.text.length > 0) {
      const id = typeof r.json.id === 'string' && r.json.id.length > 0 && r.json.id.length <= 200 ? r.json.id : null;
      return { text: r.json.text, ack: id ? { url: `${url}/ack`, token: cfg.token, body: { sessionId, id } } : null };
    }
    if (status === 'gone') return null;
    if (status === 'pending') {
      delay = retryMs;
      notFound = 0;
      // 서버가 붙잡지 않고 바로 돌려주더라도 쉴 새 없이 묻지 않는다.
      const spent = Date.now() - started;
      if (spent < minPollMs) await sleep(minPollMs - spent);
      continue;
    }
    if (r.status === 404) {
      notFound += 1;
      if (notFound >= MAX_NOT_FOUND) return null;
    } else if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
      return null; // 401(연결 해제)·403(사용자 정지)·400(모양이 틀림): 다시 해도 같다
    }
    // 네트워크 오류·5xx: 점점 길게 쉬며 다시 시도한다.
    await sleep(delay);
    delay = Math.min(Math.max(delay, 1) * 2, MAX_RETRY_MS);
  }
  return null;
}

const quit = () => process.exit(0);
process.on('uncaughtException', quit);
process.on('unhandledRejection', quit);
process.stderr.on('error', quit);

/**
 * 글을 받았다고 서버에 알린다(POST /api/reply/inbox/ack { sessionId, id }). 서버는 ack가 없으면 같은 글을 다음 대기자에게 다시 준다.
 * 실패·404(ack를 모르는 옛 서버)는 무시한다. 예외를 던지지 않는다.
 */
async function sendAck(ack) {
  if (!ack) return;
  try {
    await postJson(ack.url, ack.body, ack.token, ACK_TIMEOUT_MS);
  } catch { /* 무시 */ }
}

main().then((got) => {
  if (got === null) return quit();
  // 이 뒤로는 무슨 일이 있어도 종료 코드 2로 끝난다 — 글은 이미 stderr에 나갔다.
  const done = () => process.exit(2);
  // stderr에 다 쓴 뒤에(콜백 확인) 수신 확인을 보내고 끝낸다. 종료 코드 2 = 이 글을 세션에 전하고 깨워 달라는 뜻.
  process.stderr.write(wakeText(got.text), (err) => {
    if (err) return quit(); // 못 썼으면 전달되지 않았으니 ack도 보내지 않는다(서버가 다시 준다)
    process.removeListener('uncaughtException', quit);
    process.removeListener('unhandledRejection', quit);
    process.on('uncaughtException', done);
    process.on('unhandledRejection', done);
    // postJson의 제한시간이 있지만 혹시 몰라 한 번 더 막아 둔다.
    setTimeout(done, ACK_TIMEOUT_MS + 1000).unref();
    sendAck(got.ack).then(done, done);
  });
}).catch(quit);
