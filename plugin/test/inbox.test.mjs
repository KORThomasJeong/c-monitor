// 원격 답장 — Stop·SessionStart 훅(bin/inbox.mjs)을 실제 자식 프로세스로 돌려 본다.
// 글이 오면 stderr에 쓰고 종료 코드 2, 그 밖에는 조용히 0.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAlive } from '../lib/parent.mjs';
import { BIN, closedPort, makeSandbox, runNode, startServer } from './helpers.mjs';

const INBOX = BIN('inbox.mjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WAKE = '[c-monitor] 사용자가 웹 대시보드에서 보낸 메시지입니다. 사용자의 다음 요청으로 받아들여 처리하세요.\n\n';

let sb;
let env;
beforeEach(() => {
  sb = makeSandbox();
  env = { ...sb.env, C_MONITOR_RETRY_MS: '20', C_MONITOR_MIN_POLL_MS: '10' };
});
afterEach(() => sb.cleanup());

const connect = (server, extra = {}) => writeFileSync(join(sb.statusHome, 'config.json'), JSON.stringify({
  server, token: 'tok-1', machineId: 'm-1', machineName: '집 PC', originalStatusLine: null, ...extra,
}));
const stopInput = (extra = {}) => JSON.stringify({
  session_id: 'sess-1', cwd: sb.root, hook_event_name: 'Stop', stop_hook_active: false, ...extra,
});
const run = (input = stopInput()) => runNode(INBOX, [], { env, input });
/** 차례대로 정해 둔 응답을 주는 가짜 서버(마지막 응답을 되풀이한다). 숫자 status가 있으면 그 상태 코드로 답한다. */
const inboxServer = (replies) => {
  let i = 0;
  return startServer(() => {
    const r = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return typeof r.status === 'number' ? r : { status: 200, json: r };
  });
};
const quiet = (r) => {
  expect(r.code).toBe(0);
  expect(r.stdout.length).toBe(0);
  expect(r.stderr).toBe('');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('inbox.mjs', () => {
  it('연결돼 있지 않거나 연결이 해제됐으면 아무것도 하지 않고 0으로 끝난다', async () => {
    quiet(await run());
    const server = await inboxServer([{ status: 'message', id: 'm-1', text: '안녕' }]);
    try {
      connect(server.url, { revokedAt: new Date().toISOString() });
      quiet(await run());
      expect(server.requests).toEqual([]);
    } finally { await server.close(); }
  });

  it('입력이 깨졌거나 세션 id가 없으면 서버에 묻지 않는다', async () => {
    const server = await inboxServer([{ status: 'message', id: 'm-1', text: '안녕' }]);
    try {
      connect(server.url);
      quiet(await run('{깨진 입력'));
      quiet(await run(stopInput({ session_id: undefined })));
      expect(server.requests).toEqual([]);
    } finally { await server.close(); }
  });

  it('글이 오면 stderr에 정해진 모양으로 쓰고 종료 코드 2로 끝난다', async () => {
    const text = '테스트를 다시 돌려 주세요.\n실패하면 알려 주세요.';
    const server = await inboxServer([{ status: 'message', id: 'm-1', text }]);
    try {
      connect(server.url);
      const r = await run();
      expect(r.code).toBe(2);
      expect(r.stderr).toBe(WAKE + text);
      expect(r.stdout.length).toBe(0);
      expect(server.requests).toHaveLength(1);
      const q = server.requests[0];
      expect(q.method).toBe('POST');
      expect(q.url).toBe('/api/reply/inbox');
      expect(q.headers.authorization).toBe('Bearer tok-1');
      expect(Object.keys(q.body).sort()).toEqual(['sessionId', 'waiterId']);
      expect(q.body.sessionId).toBe('sess-1');
      expect(q.body.waiterId).toMatch(UUID);
    } finally { await server.close(); }
  });

  it('SessionStart 훅으로 불려도 똑같이 동작한다', async () => {
    const server = await inboxServer([{ status: 'message', id: 'm-1', text: '이어서 해 주세요' }]);
    try {
      connect(server.url);
      const r = await run(stopInput({ hook_event_name: 'SessionStart', source: 'resume', stop_hook_active: undefined }));
      expect(r.code).toBe(2);
      expect(r.stderr).toBe(WAKE + '이어서 해 주세요');
    } finally { await server.close(); }
  });

  it('pending이면 같은 waiterId로 되풀이해 묻는다', async () => {
    const server = await inboxServer([{ status: 'pending' }, { status: 'pending' }, { status: 'pending' }, { status: 'message', id: 'm-1', text: '계속' }]);
    try {
      connect(server.url);
      const r = await run();
      expect(r.code).toBe(2);
      expect(server.requests).toHaveLength(4);
      const ids = server.requests.map((q) => q.body.waiterId);
      expect(ids[0]).toMatch(UUID);
      expect(new Set(ids).size).toBe(1);
    } finally { await server.close(); }
  });

  it('프로세스마다 waiterId가 다르다', async () => {
    const server = await inboxServer([{ status: 'gone' }]);
    try {
      connect(server.url);
      await run();
      await run();
      const [a, b] = server.requests.map((q) => q.body.waiterId);
      expect(a).toMatch(UUID);
      expect(b).toMatch(UUID);
      expect(a).not.toBe(b);
    } finally { await server.close(); }
  });

  it('gone이면(새 대기자가 붙었거나 원격 답장이 꺼짐) 조용히 0으로 끝난다', async () => {
    const server = await inboxServer([{ status: 'pending' }, { status: 'gone' }]);
    try {
      connect(server.url);
      quiet(await run());
      expect(server.requests).toHaveLength(2);
    } finally { await server.close(); }
  });

  it('401(연결 해제)·403(사용자 정지)·400이면 다시 묻지 않고 끝난다', async () => {
    for (const status of [401, 403, 400]) {
      const server = await inboxServer([{ status, json: { error: 'x' } }]);
      try {
        connect(server.url);
        quiet(await run());
        expect(server.requests).toHaveLength(1);
      } finally { await server.close(); }
    }
  });

  it('서버 오류는 쉬었다가 다시 시도해 글을 받는다', async () => {
    const server = await inboxServer([{ status: 500, json: {} }, { status: 502, json: {} }, { status: 'message', id: 'm-1', text: '복구됨' }]);
    try {
      connect(server.url);
      const r = await run();
      expect(r.code).toBe(2);
      expect(r.stderr).toBe(WAKE + '복구됨');
      expect(server.requests).toHaveLength(3);
    } finally { await server.close(); }
  });

  it('서버가 꺼져 있다가 살아나면 이어서 글을 받는다', async () => {
    const port = await closedPort();
    connect(`http://127.0.0.1:${port}`);
    const running = run();
    await sleep(600);
    const server = await startServer(() => ({ status: 200, json: { status: 'message', id: 'm-1', text: '늦게 온 글' } }), port);
    try {
      const r = await running;
      expect(r.code).toBe(2);
      expect(r.stderr).toBe(WAKE + '늦게 온 글');
    } finally { await server.close(); }
  });

  it('404가 다섯 번 이어지면(원격 답장이 없는 옛 서버) 포기한다', async () => {
    const server = await inboxServer([{ status: 404, json: {} }]);
    try {
      connect(server.url);
      quiet(await run());
      expect(server.requests).toHaveLength(5);
    } finally { await server.close(); }
  });

  it('부모 프로세스가 죽으면 같이 끝난다(고아로 남지 않는다)', async () => {
    const server = await inboxServer([{ status: 'pending' }]);
    let pid = 0;
    try {
      connect(server.url);
      // 훅을 띄워 놓고 곧바로 끝나는 부모.
      const launcher = join(sb.root, 'launcher.mjs');
      writeFileSync(launcher, [
        "import { spawn } from 'node:child_process';",
        "const child = spawn(process.execPath, [process.argv[2]], { stdio: ['pipe', 'ignore', 'ignore'], detached: true, windowsHide: true });",
        'child.stdin.end(process.argv[3]);',
        'child.unref();',
        'process.stdout.write(String(child.pid));',
      ].join('\n'));
      const r = await runNode(launcher, [INBOX, stopInput()], { env: { ...env, C_MONITOR_MIN_POLL_MS: '100', C_MONITOR_PARENT_POLL_MS: '100' } });
      expect(r.code).toBe(0);
      pid = Number(r.stdout.toString('utf8'));
      expect(pid).toBeGreaterThan(0);

      const until = Date.now() + 8000;
      while (isAlive(pid) && Date.now() < until) await sleep(100);
      expect(isAlive(pid)).toBe(false);
      expect(server.requests.length).toBeGreaterThan(0); // 실제로 묻다가 끝난 것이다
    } finally {
      if (pid > 0 && isAlive(pid)) { try { process.kill(pid); } catch { /* 이미 끝남 */ } }
      await server.close();
    }
  });
});
