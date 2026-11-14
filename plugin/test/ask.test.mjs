// 원격 답장 — PermissionRequest 훅(bin/ask.mjs)을 실제 자식 프로세스로 돌려 본다.
// 원칙: 문제가 있으면 아무것도 출력하지 않고 0으로 끝난다(터미널의 승인 창에 맡긴다).
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAsk, describeSessionAllow, pickQuestions, sessionPermissions } from '../lib/reply.mjs';
import { safeToolInput } from '../lib/toolinput.mjs';
import { BIN, closedPort, makeSandbox, runNode, startServer } from './helpers.mjs';

const ASK = BIN('ask.mjs');

let sb;
let env;
beforeEach(() => {
  sb = makeSandbox();
  // 다시 시도하는 간격을 줄여 테스트가 빨리 끝나게 한다.
  env = { ...sb.env, C_MONITOR_RETRY_MS: '20', C_MONITOR_MIN_POLL_MS: '10' };
});
afterEach(() => sb.cleanup());

const connect = (server, extra = {}) => writeFileSync(join(sb.statusHome, 'config.json'), JSON.stringify({
  server, token: 'tok-1', machineId: 'm-1', machineName: '집 PC', originalStatusLine: null, ...extra,
}));
const SUGGESTIONS = [
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run:*' }], behavior: 'allow', destination: 'localSettings' },
  { type: 'addDirectories', directories: ['/work/other'], destination: 'userSettings' },
  { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
];
const permissionInput = (extra = {}) => ({
  session_id: 'sess-1', cwd: '/work/x', permission_mode: 'default', hook_event_name: 'PermissionRequest',
  tool_name: 'Bash', tool_input: { command: 'npm run build', description: '빌드' }, permission_suggestions: SUGGESTIONS, ...extra,
});
const QUESTIONS = [
  {
    question: '어느 색으로 할까요?', header: '색', multiSelect: false,
    options: [{ label: '파랑', description: '차분한 색' }, { label: '빨강', description: '눈에 띄는 색' }],
  },
  { question: '어디에 적용할까요?', header: '범위', multiSelect: true, options: [{ label: '버튼' }, { label: '링크' }] },
];
const questionInput = (extra = {}) => permissionInput({
  tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS, metadata: { source: 'test' } }, permission_suggestions: undefined, ...extra,
});
const run = (input) => runNode(ASK, [], { env, input: typeof input === 'string' ? input : JSON.stringify(input) });

/** 등록에는 requestId를, 대기에는 차례대로 정해 둔 응답을 주는 가짜 서버(마지막 응답을 되풀이한다). */
const replyServer = (waits, ask = { status: 200, json: { requestId: 'req-1' } }) => {
  let i = 0;
  return startServer((req) => {
    if (req.url === '/api/reply/ask') return ask;
    if (req.url === '/api/reply/wait') {
      const w = waits[Math.min(i, waits.length - 1)];
      i += 1;
      return 'status' in w && typeof w.status === 'number' ? w : { status: 200, json: w };
    }
    return { status: 404, json: {} };
  });
};
const answered = (answer) => ({ status: 'answered', answer });
const quiet = (r) => {
  expect(r.code).toBe(0);
  expect(r.stdout.length).toBe(0);
  expect(r.stderr).toBe('');
};
/** stdout이 JSON 한 줄뿐인지 확인하고 그 값을 돌려준다. */
const decisionOf = (r) => {
  expect(r.code).toBe(0);
  const text = r.stdout.toString('utf8');
  expect(text.endsWith('\n')).toBe(true);
  expect(text.trim().split('\n')).toHaveLength(1);
  return JSON.parse(text);
};

describe('ask.mjs — 조용히 끝나는 경우', () => {
  it('연결돼 있지 않으면 아무것도 출력하지 않고 0으로 끝난다', async () => {
    quiet(await run(permissionInput()));
  });

  it('서버에서 연결을 해제했으면(revokedAt) 서버에 묻지 않는다', async () => {
    const server = await replyServer([answered({ type: 'permission', behavior: 'allow' })]);
    try {
      connect(server.url, { revokedAt: new Date().toISOString() });
      quiet(await run(permissionInput()));
      expect(server.requests).toEqual([]);
    } finally { await server.close(); }
  });

  it('입력이 깨졌거나 다른 이벤트이거나 도구 이름이 없으면 서버에 묻지 않는다', async () => {
    const server = await replyServer([answered({ type: 'permission', behavior: 'allow' })]);
    try {
      connect(server.url);
      quiet(await run('{깨진 입력'));
      quiet(await run(permissionInput({ hook_event_name: 'PreToolUse' })));
      quiet(await run(permissionInput({ tool_name: undefined })));
      quiet(await run(permissionInput({ session_id: '' })));
      quiet(await run(questionInput({ tool_input: { questions: [] } })));
      expect(server.requests).toEqual([]);
    } finally { await server.close(); }
  });

  it('서버가 꺼져 있으면 3초 남짓 안에 조용히 끝난다', async () => {
    connect(`http://127.0.0.1:${await closedPort()}`);
    const r = await run(permissionInput());
    quiet(r);
    expect(r.ms).toBeLessThan(4500);
  });

  it('서버가 대답하지 않아도 등록에 3초 넘게 쓰지 않는다', async () => {
    const hang = createServer(() => { /* 대답하지 않음 */ });
    await new Promise((r) => hang.listen(0, '127.0.0.1', r));
    try {
      connect(`http://127.0.0.1:${hang.address().port}`);
      const r = await run(permissionInput());
      quiet(r);
      expect(r.ms).toBeGreaterThan(2500);
      expect(r.ms).toBeLessThan(4500);
    } finally { hang.closeAllConnections?.(); hang.close(); }
  });

  it('이 컴퓨터의 원격 답장이 꺼져 있으면(disabled) 기다리지 않고 끝난다', async () => {
    const server = await replyServer([answered({ type: 'permission', behavior: 'allow' })], { status: 200, json: { disabled: true } });
    try {
      connect(server.url);
      quiet(await run(permissionInput()));
      expect(server.requests.map((q) => q.url)).toEqual(['/api/reply/ask']);
    } finally { await server.close(); }
  });

  it('등록이 거절되면(401·404·500) 기다리지 않고 끝난다', async () => {
    for (const status of [401, 404, 500]) {
      const server = await replyServer([answered({ type: 'permission', behavior: 'allow' })], { status, json: { error: 'x' } });
      try {
        connect(server.url);
        quiet(await run(permissionInput()));
        expect(server.requests.map((q) => q.url)).toEqual(['/api/reply/ask']);
      } finally { await server.close(); }
    }
  });

  it('터미널에서 먼저 답해 요청이 없어지면(gone) 아무 결정도 내지 않는다', async () => {
    const server = await replyServer([{ status: 'pending' }, { status: 'gone' }]);
    try {
      connect(server.url);
      quiet(await run(permissionInput()));
      expect(server.requests.map((q) => q.url)).toEqual(['/api/reply/ask', '/api/reply/wait', '/api/reply/wait']);
    } finally { await server.close(); }
  });

  it('대기 요청이 다섯 번 연속 실패하면 포기한다', async () => {
    const server = await replyServer([{ status: 500, json: {} }]);
    try {
      connect(server.url);
      quiet(await run(permissionInput()));
      expect(server.requests.filter((q) => q.url === '/api/reply/wait')).toHaveLength(5);
    } finally { await server.close(); }
  });

  it('대기 요청이 404(모르는 요청)면 바로 끝낸다', async () => {
    const server = await replyServer([{ status: 404, json: { error: 'not_found' } }]);
    try {
      connect(server.url);
      quiet(await run(permissionInput()));
      expect(server.requests.filter((q) => q.url === '/api/reply/wait')).toHaveLength(1);
    } finally { await server.close(); }
  });

  it('질문에 답 없이 허용만 오거나 모르는 모양의 답이 오면 아무것도 출력하지 않는다', async () => {
    for (const [input, answer] of [
      [questionInput(), { type: 'permission', behavior: 'allow' }],
      [permissionInput(), { type: 'answer', answers: { x: 'y' } }],
      [permissionInput(), { type: 'permission', behavior: 'always' }],
      [permissionInput(), null],
    ]) {
      const server = await replyServer([answered(answer)]);
      try {
        connect(server.url);
        quiet(await run(input));
      } finally { await server.close(); }
    }
  });
});

describe('ask.mjs — 웹에서 온 답을 클로드코드에 돌려준다', () => {
  it('허용: pending 동안 되풀이해 묻다가 allow를 JSON 한 줄로 출력한다', async () => {
    const server = await replyServer([{ status: 'pending' }, { status: 'pending' }, answered({ type: 'permission', behavior: 'allow' })]);
    try {
      connect(server.url);
      const r = await run(permissionInput());
      expect(r.stdout.toString('utf8')).toBe('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n');
      expect(r.code).toBe(0);
      expect(server.requests.map((q) => q.url)).toEqual(['/api/reply/ask', '/api/reply/wait', '/api/reply/wait', '/api/reply/wait']);
      expect(server.requests.every((q) => q.method === 'POST' && q.headers.authorization === 'Bearer tok-1')).toBe(true);
      expect(server.requests.slice(1).map((q) => q.body)).toEqual([{ requestId: 'req-1' }, { requestId: 'req-1' }, { requestId: 'req-1' }]);
    } finally { await server.close(); }
  });

  it('대기 중 서버 오류가 몇 번 나도 다시 시도해 답을 받는다', async () => {
    const server = await replyServer([{ status: 502, json: {} }, { status: 503, json: {} }, answered({ type: 'permission', behavior: 'allow' })]);
    try {
      connect(server.url);
      expect(decisionOf(await run(permissionInput())).hookSpecificOutput.decision).toEqual({ behavior: 'allow' });
    } finally { await server.close(); }
  });

  it('이 세션 동안 허용: 제안의 destination을 session으로 바꿔 updatedPermissions로 돌려준다', async () => {
    const server = await replyServer([answered({ type: 'permission', behavior: 'allow_session' })]);
    try {
      connect(server.url);
      expect(decisionOf(await run(permissionInput()))).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'allow',
            updatedPermissions: [
              { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run:*' }], behavior: 'allow', destination: 'session' },
              { type: 'addDirectories', directories: ['/work/other'], destination: 'session' },
              { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
            ],
          },
        },
      });
    } finally { await server.close(); }
  });

  it('이 세션 동안 허용인데 제안이 없으면 그냥 허용한다', async () => {
    const server = await replyServer([answered({ type: 'permission', behavior: 'allow_session' })]);
    try {
      connect(server.url);
      const out = decisionOf(await run(permissionInput({ permission_suggestions: undefined })));
      expect(out.hookSpecificOutput.decision).toEqual({ behavior: 'allow' });
    } finally { await server.close(); }
  });

  it('거부: 글이 없으면 기본 문구, 글이 있으면 그 글을 붙여 message로 돌려준다', async () => {
    for (const [answer, message] of [
      [{ type: 'permission', behavior: 'deny' }, '사용자가 웹 대시보드에서 거부했습니다.'],
      [{ type: 'permission', behavior: 'deny', message: '   ' }, '사용자가 웹 대시보드에서 거부했습니다.'],
      [{ type: 'permission', behavior: 'deny', message: '테스트부터 돌려 주세요' }, '사용자가 웹 대시보드에서 거부하고 이렇게 말했습니다: 테스트부터 돌려 주세요'],
    ]) {
      const server = await replyServer([answered(answer)]);
      try {
        connect(server.url);
        expect(decisionOf(await run(permissionInput()))).toEqual({
          hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } },
        });
      } finally { await server.close(); }
    }
  });

  it('질문 중에 글로 거부하면 질문도 deny로 끝낸다', async () => {
    const server = await replyServer([answered({ type: 'permission', behavior: 'deny', message: '다른 방법으로 해 주세요' })]);
    try {
      connect(server.url);
      expect(decisionOf(await run(questionInput())).hookSpecificOutput.decision).toEqual({
        behavior: 'deny', message: '사용자가 웹 대시보드에서 거부하고 이렇게 말했습니다: 다른 방법으로 해 주세요',
      });
    } finally { await server.close(); }
  });

  it('질문 답: 원래 tool_input 전체에 answers를 더해 updatedInput으로 돌려준다', async () => {
    const answers = { '어느 색으로 할까요?': '파랑', '어디에 적용할까요?': '버튼, 링크' };
    const server = await replyServer([{ status: 'pending' }, answered({ type: 'answer', answers })]);
    try {
      connect(server.url);
      expect(decisionOf(await run(questionInput()))).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow', updatedInput: { questions: QUESTIONS, metadata: { source: 'test' }, answers } },
        },
      });
    } finally { await server.close(); }
  });

  it('질문에 비밀이 있으면 서버에는 가려 보내고, 클로드코드에는 가리지 않은 원본으로 답한다', async () => {
    const key = 'sk-' + 'ant-' + 'a1B2c3D4e5F6g7H8i9J0k1L2';
    const questions = [{
      question: `${key} 키를 어떻게 할까요?`, header: '키', multiSelect: false,
      options: [{ label: `${key} 그대로 쓰기` }, { label: '새로 만들기' }],
    }];
    const server = await startServer((req) => {
      if (req.url === '/api/reply/ask') return { status: 200, json: { requestId: 'req-1' } };
      // 웹은 서버가 받은(가려진) 글로 답한다.
      const q = server.requests[0].body.questions[0];
      return { status: 200, json: answered({ type: 'answer', answers: { [q.question]: q.options[0].label } }) };
    });
    try {
      connect(server.url);
      const out = decisionOf(await run(questionInput({ tool_input: { questions } })));
      expect(JSON.stringify(server.requests[0].body)).not.toContain(key);
      expect(server.requests[0].body.questions[0].question).toBe('•••••••• 키를 어떻게 할까요?');
      expect(out.hookSpecificOutput.decision.updatedInput).toEqual({
        questions, answers: { [`${key} 키를 어떻게 할까요?`]: `${key} 그대로 쓰기` },
      });
    } finally { await server.close(); }
  });
});

describe('ask.mjs — 등록 본문', () => {
  it('승인: 계약 모양으로 보내고 비밀을 가린다', async () => {
    const key = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const server = await replyServer([{ status: 'gone' }]);
    try {
      connect(server.url);
      await run(permissionInput({
        tool_input: { command: `curl -H "Authorization: Bearer ${key}" https://example.com`, password: 'hunter2hunter2' },
        agent_id: 'agent-7',
      }));
      const q = server.requests[0];
      expect(q.url).toBe('/api/reply/ask');
      expect(q.headers.authorization).toBe('Bearer tok-1');
      expect(Object.keys(q.body).sort()).toEqual(['agentId', 'at', 'kind', 'sessionAllow', 'sessionId', 'toolInput', 'toolName']);
      expect(q.body).toMatchObject({
        sessionId: 'sess-1', kind: 'permission', toolName: 'Bash', agentId: 'agent-7',
        toolInput: { command: 'curl -H "Authorization: Bearer ••••••••" https://example.com', password: '••••••••' },
        sessionAllow: '이 세션 동안 `Bash(npm run:*)` 허용 · 이 세션 동안 /work/other 접근 허용 · 이 세션 동안 파일 수정 자동 허용',
      });
      expect(new Date(q.body.at).toISOString()).toBe(q.body.at);
      expect(JSON.stringify(q.body)).not.toContain(key);
      expect(JSON.stringify(q.body)).not.toContain('hunter2');
    } finally { await server.close(); }
  });

  it('큰 입력은 훅 이벤트와 같은 규칙으로 preview만 보낸다', async () => {
    const server = await replyServer([{ status: 'gone' }]);
    try {
      connect(server.url);
      const tool_input = { file_path: '/work/x/a.txt', content: '가'.repeat(20_000) };
      await run(permissionInput({ tool_name: 'Write', tool_input }));
      const sent = server.requests[0].body.toolInput;
      expect(Object.keys(sent)).toEqual(['preview']);
      expect(sent.preview.length).toBe(2001);
      expect(sent).toEqual(safeToolInput(tool_input));
    } finally { await server.close(); }
  });

  it('질문: kind는 question, questions는 계약 모양으로 추리고 sessionAllow는 null', async () => {
    const server = await replyServer([{ status: 'gone' }]);
    try {
      connect(server.url);
      await run(questionInput({ permission_suggestions: SUGGESTIONS }));
      const body = server.requests[0].body;
      expect(body).toMatchObject({ kind: 'question', toolName: 'AskUserQuestion', agentId: null, sessionAllow: null });
      expect(body.questions).toEqual([
        { question: '어느 색으로 할까요?', header: '색', multiSelect: false, options: [{ label: '파랑', description: '차분한 색' }, { label: '빨강', description: '눈에 띄는 색' }] },
        { question: '어디에 적용할까요?', header: '범위', multiSelect: true, options: [{ label: '버튼' }, { label: '링크' }] },
      ]);
    } finally { await server.close(); }
  });
});

describe('원격 답장 본문 만들기(lib/reply.mjs)', () => {
  it('sessionAllow 문구: 규칙·폴더·모드, 여러 개는 " · "로 잇는다', () => {
    expect(describeSessionAllow([SUGGESTIONS[0]])).toBe('이 세션 동안 `Bash(npm run:*)` 허용');
    expect(describeSessionAllow([{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'WebFetch' }, { toolName: 'Read', ruleContent: '//tmp/**' }] }]))
      .toBe('이 세션 동안 `WebFetch`, `Read(//tmp/**)` 허용');
    expect(describeSessionAllow([SUGGESTIONS[1]])).toBe('이 세션 동안 /work/other 접근 허용');
    expect(describeSessionAllow([SUGGESTIONS[2]])).toBe('이 세션 동안 파일 수정 자동 허용');
    expect(describeSessionAllow([SUGGESTIONS[1], SUGGESTIONS[2]])).toBe('이 세션 동안 /work/other 접근 허용 · 이 세션 동안 파일 수정 자동 허용');
  });

  it('제안이 없으면 sessionAllow는 null', () => {
    for (const none of [undefined, null, [], 'x', [null]]) expect(describeSessionAllow(none)).toBeNull();
    expect(buildAsk(permissionInput({ permission_suggestions: [] })).body.sessionAllow).toBeNull();
  });

  it('설명할 수 없는 제안(거부 규칙·규칙 삭제·승인 건너뛰기 모드)은 문구에도 updatedPermissions에도 넣지 않는다', () => {
    const odd = [
      { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' },
      { type: 'removeRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
      { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
    ];
    expect(describeSessionAllow(odd)).toBeNull();
    expect(sessionPermissions(odd)).toEqual([]);
    expect(describeSessionAllow([...odd, SUGGESTIONS[2]])).toBe('이 세션 동안 파일 수정 자동 허용');
    expect(sessionPermissions([...odd, SUGGESTIONS[2]])).toEqual([SUGGESTIONS[2]]);
  });

  it('sessionAllow는 500자를 넘지 않고 비밀을 가린다', () => {
    const long = describeSessionAllow([{ type: 'addDirectories', directories: ['/' + 'a'.repeat(900)], destination: 'session' }]);
    expect(long.length).toBe(500);
    const key = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    expect(describeSessionAllow([{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: `curl ${key}` }] }]))
      .toBe('이 세션 동안 `Bash(curl ••••••••)` 허용');
  });

  it('질문은 4개·선택지는 10개까지만, 모양이 틀린 것은 뺀다', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      question: `질문 ${i}`, options: [...Array.from({ length: 12 }, (_, j) => ({ label: `선택 ${j}` })), { label: '' }, null],
    }));
    const picked = pickQuestions({ questions: [null, { question: '' }, ...many] });
    expect(picked.questions).toHaveLength(4);
    expect(picked.questions[0]).toEqual({ question: '질문 0', options: Array.from({ length: 10 }, (_, j) => ({ label: `선택 ${j}` })) });
    expect(pickQuestions({})).toBeNull();
    expect(pickQuestions(null)).toBeNull();
  });
});
