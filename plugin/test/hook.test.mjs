// 훅 진입점을 실제 자식 프로세스로 돌려 본다(계획 Review Focus 1).
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { osLabel } from '../lib/os.mjs';
import { BIN, closedPort, makeSandbox, runNode, startServer } from './helpers.mjs';

const HOOK = BIN('hook.mjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let sb;
let transcript;
beforeEach(() => {
  sb = makeSandbox();
  transcript = join(sb.root, 'sess-1.jsonl');
  writeFileSync(join(sb.configDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'dev@example.com' } }));
});
afterEach(() => sb.cleanup());

const connect = (server) => writeFileSync(join(sb.statusHome, 'config.json'), JSON.stringify({
  server, token: 'tok-1', machineId: 'm-1', machineName: '집 PC', originalStatusLine: null,
}));
const readConfig = () => JSON.parse(readFileSync(join(sb.statusHome, 'config.json'), 'utf8'));
const queueFiles = () => {
  const dir = join(sb.statusHome, 'queue');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
};
const say = (role, text) => appendFileSync(transcript, JSON.stringify({
  type: role, isSidechain: false, timestamp: new Date().toISOString(),
  message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
}) + '\r\n');
const hookInput = (event, extra = {}) => JSON.stringify({
  session_id: 'sess-1', transcript_path: transcript, cwd: sb.root, hook_event_name: event, ...extra,
});
const run = (input) => runNode(HOOK, [], { env: sb.env, input });

describe('hook.mjs', () => {
  it('연결돼 있지 않으면 아무것도 하지 않고 0으로 끝난다', async () => {
    const r = await run(hookInput('UserPromptSubmit', { prompt: '안녕' }));
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(0);
    expect(queueFiles()).toEqual([]);
  });

  it('입력이 깨져 있어도 0으로 끝나고 아무것도 출력하지 않는다', async () => {
    connect('http://127.0.0.1:1');
    const r = await run('{깨진 입력');
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(0);
  });

  it('서버가 꺼져 있으면 큐에 남기고, 서버가 살아나면 다음 훅에서 순서대로 보낸다', async () => {
    const port = await closedPort();
    connect(`http://127.0.0.1:${port}`);

    say('user', '첫 질문');
    const a = await run(hookInput('UserPromptSubmit', { prompt: '첫 질문' }));
    expect(a.code).toBe(0);
    expect(a.stdout.length).toBe(0);
    expect(a.ms).toBeLessThan(4000);
    expect(queueFiles().length).toBe(1);

    say('assistant', '첫 답변');
    const b = await run(hookInput('Stop', { last_assistant_message: '첫 답변' }));
    expect(b.code).toBe(0);
    expect(b.ms).toBeLessThan(4000);
    expect(queueFiles().length).toBe(2);

    // 같은 포트로 서버를 켠다.
    const server = await startServer(() => ({ status: 200, json: { accepted: 1 } }), port);
    try {
      say('user', '둘째 질문');
      const c = await run(hookInput('UserPromptSubmit', { prompt: '둘째 질문' }));
      expect(c.code).toBe(0);
      expect(c.stdout.length).toBe(0);
      expect(queueFiles()).toEqual([]);

      expect(server.requests.map((r) => r.url)).toEqual(['/api/ingest', '/api/ingest', '/api/ingest']);
      expect(server.requests.every((r) => r.headers.authorization === 'Bearer tok-1')).toBe(true);
      const bodies = server.requests.map((r) => r.body);
      expect(bodies.map((x) => x.events[0].event)).toEqual(['UserPromptSubmit', 'Stop', 'UserPromptSubmit']);
      expect(bodies.map((x) => x.transcript[0].seq)).toEqual([0, 1, 2]);
      expect(bodies.map((x) => x.transcript[0].lines[0].text)).toEqual(['첫 질문', '첫 답변', '둘째 질문']);

      // 계약(IngestBatch) 모양
      const first = bodies[0];
      expect(first.machine.name).toBe('집 PC');
      expect(typeof first.machine.os).toBe('string');
      expect(first.machine.pluginVersion).toMatch(/^\d+\.\d+\.\d+/);
      const e = first.events[0];
      expect(e.id).toMatch(UUID);
      expect(e.sessionId).toBe('sess-1');
      expect(new Date(e.at).toISOString()).toBe(e.at);
      expect(e.account).toBe('dev@example.com');
      expect(e.cwd).toBe(sb.root);
      expect(e.branch).toBeNull();
      expect(e.model).toBeNull();
      expect(e.data).toEqual({ prompt: '첫 질문' });
      expect(first.transcript[0].sessionId).toBe('sess-1');
    } finally { await server.close(); }
  });

  it('브랜치·모델을 읽고, data의 비밀을 가리며 tool_response는 보내지 않는다', async () => {
    const server = await startServer();
    try {
      connect(server.url);
      mkdirSync(join(sb.root, 'repo', '.git'), { recursive: true });
      writeFileSync(join(sb.root, 'repo', '.git', 'HEAD'), 'ref: refs/heads/feature/버튼-색\n');
      const cwd = join(sb.root, 'repo', 'src', 'deep');
      mkdirSync(cwd, { recursive: true });
      const key = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
      const r = await run(JSON.stringify({
        session_id: 'sess-2', cwd, hook_event_name: 'PostToolUse', model: 'claude-test-1',
        tool_name: 'Bash', tool_input: { command: `git push https://${key}@example.com/x.git` },
        tool_response: { stdout: '아주 긴 출력' },
      }));
      expect(r.code).toBe(0);
      const body = server.requests[0].body;
      const e = body.events[0];
      expect(e.branch).toBe('feature/버튼-색');
      expect(e.model).toBe('claude-test-1');
      expect(e.data.tool_name).toBe('Bash');
      expect(e.data.tool_input.command).toBe('git push https://••••••••@example.com/x.git');
      expect(e.data.tool_response).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(key);
      expect(body.transcript).toEqual([]); // transcript_path가 없으면 대화는 비어 있다
    } finally { await server.close(); }
  });

  it('모르는 이벤트 이름은 보내지 않는다', async () => {
    const server = await startServer();
    try {
      connect(server.url);
      const r = await run(hookInput('PreCompact'));
      expect(r.code).toBe(0);
      expect(server.requests).toEqual([]);
      expect(queueFiles()).toEqual([]);
    } finally { await server.close(); }
  });

  it('큰 대화는 512KB 이하 요청 여러 개로 나눠 보낸다', async () => {
    const server = await startServer();
    try {
      connect(server.url);
      for (let i = 0; i < 30; i++) say('assistant', `${i}번 ` + '가'.repeat(20_000)); // 줄마다 약 60KB
      const r = await run(hookInput('Stop'));
      expect(r.code).toBe(0);
      expect(server.requests.length).toBeGreaterThan(3);
      expect(server.requests.every((q) => q.bytes <= 512 * 1024)).toBe(true);
      const seqs = server.requests.flatMap((q) => q.body.transcript.flatMap((c) => c.lines.map((_, i) => c.seq + i)));
      expect(seqs).toEqual(Array.from({ length: 30 }, (_, i) => i));
      expect(server.requests.map((q) => q.body.events.length)).toEqual([1, ...Array(server.requests.length - 1).fill(0)]);
    } finally { await server.close(); }
  });

  it('서버가 대답하지 않아도 3초 조금 넘는 시간 안에 0으로 끝나고 큐에 남는다', async () => {
    const { createServer } = await import('node:http');
    const hang = createServer(() => { /* 대답하지 않음 */ });
    await new Promise((r) => hang.listen(0, '127.0.0.1', r));
    try {
      connect(`http://127.0.0.1:${hang.address().port}`);
      const r = await run(hookInput('Stop'));
      expect(r.code).toBe(0);
      expect(r.stdout.length).toBe(0);
      expect(r.ms).toBeLessThan(4500);
      expect(queueFiles().length).toBe(1);
    } finally { hang.closeAllConnections?.(); hang.close(); }
  });

  it('훅 여러 개가 동시에 돌아도 모두 0으로 끝나고 이벤트를 잃지 않는다', async () => {
    const server = await startServer();
    try {
      connect(server.url);
      say('user', '동시에 실행');
      const names = ['PreToolUse', 'PreToolUse', 'PostToolUse', 'PostToolUse', 'Notification', 'Stop'];
      const results = await Promise.all(names.map((n) => run(hookInput(n, { tool_name: 'Bash' }))));
      expect(results.map((r) => r.code)).toEqual(names.map(() => 0));
      expect(results.every((r) => r.stdout.length === 0)).toBe(true);
      expect(queueFiles()).toEqual([]);
      const events = server.requests.flatMap((q) => q.body.events.map((e) => e.event));
      expect(events.sort()).toEqual([...names].sort());
      // 같은 대화 줄을 두 훅이 함께 읽었더라도 순번은 같다(서버가 중복을 무시한다).
      const seqs = server.requests.flatMap((q) => q.body.transcript.map((c) => c.seq));
      expect(seqs.every((x) => x === 0)).toBe(true);
    } finally { await server.close(); }
  });

  it('서버가 400·413으로 거절한 묶음은 버리고, 403(사용자 정지)이면 큐에 남긴다', async () => {
    let status = 400;
    const server = await startServer(() => ({ status, json: {} }));
    try {
      connect(server.url);
      await run(hookInput('Stop'));
      expect(queueFiles()).toEqual([]);
      status = 403;
      await run(hookInput('Stop'));
      expect(queueFiles().length).toBe(1);
      expect(readConfig().revokedAt).toBeUndefined();
      // 정지가 풀리면 이어서 보낸다.
      status = 200;
      await run(hookInput('Stop'));
      expect(queueFiles()).toEqual([]);
    } finally { await server.close(); }
  });

  it('401(서버에서 연결 해제)이면 큐를 비우고 해제 표시를 남기며, 그 뒤로는 아무것도 보내지 않는다', async () => {
    let status = 403;
    const server = await startServer(() => ({ status, json: {} }));
    try {
      connect(server.url);
      await run(hookInput('Stop')); // 큐에 하나 남겨 둔다
      expect(queueFiles().length).toBe(1);

      status = 401;
      const r = await run(hookInput('Stop'));
      expect(r.code).toBe(0);
      expect(r.stdout.length).toBe(0);
      expect(queueFiles()).toEqual([]); // 방금 묶음과 남아 있던 묶음 모두 버린다
      const cfg = readConfig();
      expect(new Date(cfg.revokedAt).toISOString()).toBe(cfg.revokedAt);
      expect(cfg).toMatchObject({ server: server.url, token: 'tok-1', machineName: '집 PC' }); // 나머지는 그대로

      const sentSoFar = server.requests.length;
      say('user', '해제된 뒤의 질문');
      const after = await run(hookInput('UserPromptSubmit', { prompt: '해제된 뒤의 질문' }));
      expect(after.code).toBe(0);
      expect(after.stdout.length).toBe(0);
      expect(server.requests.length).toBe(sentSoFar);
      expect(queueFiles()).toEqual([]);
    } finally { await server.close(); }
  });

  it('운영체제는 연결할 때와 같은 표기(osLabel)로 보낸다', async () => {
    const server = await startServer();
    try {
      connect(server.url);
      await run(hookInput('Stop'));
      expect(server.requests[0].body.machine.os).toBe(osLabel());
    } finally { await server.close(); }
  });
});

describe('hook.mjs — 상태줄 래퍼 따라 올리기', () => {
  const wrapper = () => join(sb.statusHome, 'bin', 'statusline.mjs');
  const shipped = () => readFileSync(BIN('statusline.mjs'), 'utf8');
  const version = () => JSON.parse(readFileSync(join(BIN('..'), '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const connectAs = (pluginVersion) => writeFileSync(join(sb.statusHome, 'config.json'), JSON.stringify({
    server: 'http://127.0.0.1:1', token: 'tok-1', machineId: 'm-1', machineName: '집 PC', originalStatusLine: null,
    ...(pluginVersion === undefined ? {} : { pluginVersion }),
  }));
  const oldWrapper = () => {
    mkdirSync(join(sb.statusHome, 'bin'), { recursive: true });
    writeFileSync(wrapper(), '// 옛 래퍼\n');
  };

  it('플러그인이 설정에 적힌 버전보다 새것이면 래퍼 복사본을 바꾸고 버전을 올린다', async () => {
    connectAs('0.0.1');
    oldWrapper();
    const r = await run(hookInput('UserPromptSubmit', { prompt: '안녕' }));
    expect(r.code).toBe(0);
    expect(readFileSync(wrapper(), 'utf8')).toBe(shipped());
    expect(readConfig()).toMatchObject({ pluginVersion: version(), token: 'tok-1', machineName: '집 PC' });
    expect(readdirSync(join(sb.statusHome, 'bin'))).toEqual(['statusline.mjs']); // 임시 파일이 남지 않는다
  });

  it('버전이 적혀 있지 않은 예전 설정도 올린다', async () => {
    connectAs(undefined);
    oldWrapper();
    await run(hookInput('Stop'));
    expect(readFileSync(wrapper(), 'utf8')).toBe(shipped());
    expect(readConfig().pluginVersion).toBe(version());
  });

  it('버전이 같거나 설정 쪽이 더 높으면 래퍼를 건드리지 않는다', async () => {
    for (const v of [version(), '99.0.0']) {
      connectAs(v);
      oldWrapper();
      await run(hookInput('Stop'));
      expect(readFileSync(wrapper(), 'utf8')).toBe('// 옛 래퍼\n');
      expect(readConfig().pluginVersion).toBe(v);
    }
  });

  it('래퍼를 설치한 적이 없으면 파일을 만들지 않고 버전만 올린다', async () => {
    connectAs('0.0.1');
    await run(hookInput('Stop'));
    expect(existsSync(wrapper())).toBe(false);
    expect(readConfig().pluginVersion).toBe(version());
  });
});
