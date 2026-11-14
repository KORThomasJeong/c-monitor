// 플러그인이 만든 JSON이 공용 계약(shared/src/contract.ts)을 실제로 통과하는지 확인한다.
// 플러그인 코드는 계약 파일을 import하지 않지만(런타임 의존성 0), 테스트에서는 같은 스키마로 검증한다.
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOOK_EVENTS, IngestBatchSchema, MAX_BATCH_BYTES, MAX_LINE_BYTES, MESSAGE_MAX_CHARS, REPLY_MIN_PLUGIN,
  ReplyAnswerSchema, ReplyAskSchema, ReplyInboxSchema, ReplyWaitSchema,
} from '../../shared/src/contract.ts';
import * as contract from '../../shared/src/contract.ts';
import { z } from 'zod';
import * as queue from '../lib/queue.mjs';
import { compareVersions } from '../lib/wrapper.mjs';
import * as transcriptLib from '../lib/transcript.mjs';
import { BIN, PLUGIN_ROOT, makeSandbox, runNode, startServer } from './helpers.mjs';

let sb;
beforeEach(() => {
  sb = makeSandbox();
  writeFileSync(join(sb.configDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'dev@example.com' } }));
});
afterEach(() => sb.cleanup());

// ── 3차(0.3.0)에서 플러그인이 새로 보내는 모양 ─────────────────────────
// shared 계약에 아직 없으면 아래 기대 모양으로 검사하고, 들어오면 shared 쪽 스키마로 검사한다.
// (shared/src/contract.ts 에 넣을 정의와 같다.)
const iso = z.string().datetime({ offset: true });
const EXPECTED_SESSION_STAT = z.object({
  sessionId: z.string().min(1).max(200),
  /** 컨텍스트 사용률 0~100(소수 1자리). 상태줄 입력으로 알 수 없으면 null */
  contextPct: z.number().min(0).max(100).nullable(),
  /** 세션 누적 비용(USD). 알 수 없으면 null */
  costUsd: z.number().min(0).nullable(),
  at: iso,
});
const SessionStatSchema = contract.SessionStatSchema ?? EXPECTED_SESSION_STAT;
const IngestWithStatsSchema = contract.IngestBatchSchema.shape.sessionStats
  ? contract.IngestBatchSchema
  : contract.IngestBatchSchema.extend({ sessionStats: z.array(SessionStatSchema).max(100).optional() });
const ReplyInboxAckSchema = contract.ReplyInboxAckSchema
  ?? z.object({ sessionId: z.string().min(1).max(200), id: z.string().min(1).max(200) });

const connect = (server) => writeFileSync(join(sb.statusHome, 'config.json'), JSON.stringify({
  server, token: 'tok-1', machineId: 'm-1', machineName: '집 PC', pluginVersion: '0.1.0', originalStatusLine: null,
}));

describe('공용 계약과 맞는지', () => {
  it('크기 상수가 계약과 같다', () => {
    expect(transcriptLib.MAX_LINE_BYTES).toBe(MAX_LINE_BYTES);
    expect(queue.MAX_BATCH_BYTES).toBe(MAX_BATCH_BYTES);
  });

  it('hooks.json이 계약의 이벤트를 모두, 비동기로 등록한다', () => {
    const { hooks } = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
    // PermissionRequest 는 서버로 보내는 이벤트가 아니라 원격 답장용 훅이다.
    expect(Object.keys(hooks).sort()).toEqual([...HOOK_EVENTS, 'PermissionRequest'].sort());
    for (const event of HOOK_EVENTS) {
      const groups = hooks[event];
      expect(groups).toHaveLength(1);
      expect(groups[0].matcher).toBeUndefined();
      expect(groups[0].hooks[0]).toEqual(
        { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/hook.mjs"', async: true, timeout: 10 },
      );
    }
  });

  it('hooks.json이 원격 답장 훅을 등록한다: 승인은 동기, 글 받기는 Stop·SessionStart에 깨우기 훅으로', () => {
    const { hooks } = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
    expect(hooks.PermissionRequest).toEqual([
      { hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/ask.mjs"', timeout: 43200 }] },
    ]);
    const inbox = { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/inbox.mjs"', async: true, asyncRewake: true, timeout: 86400 };
    for (const event of HOOK_EVENTS) {
      expect(hooks[event][0].hooks.slice(1)).toEqual(event === 'Stop' || event === 'SessionStart' ? [inbox] : []);
    }
  });

  it('플러그인 버전이 원격 답장을 지원하는 버전(REPLY_MIN_PLUGIN) 이상이다', () => {
    const plugin = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(compareVersions(plugin.version, REPLY_MIN_PLUGIN)).toBeGreaterThanOrEqual(0);
  });

  it('매니페스트 이름과 마켓플레이스 항목이 맞는다', () => {
    const plugin = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
    const market = JSON.parse(readFileSync(join(PLUGIN_ROOT, '..', '.claude-plugin', 'marketplace.json'), 'utf8'));
    expect(plugin.name).toBe('c-monitor');
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(market.name).toBe('c-monitor');
    expect(market.plugins).toHaveLength(1);
    expect(market.plugins[0]).toMatchObject({ name: 'c-monitor', source: './plugin' });
  });

  it('모든 훅 이벤트의 전송 본문이 IngestBatchSchema를 통과한다', async () => {
    const server = await startServer();
    try {
      connect(server.url);
      const transcript = join(sb.root, 'sess-1.jsonl');
      const fixture = readFileSync(join(PLUGIN_ROOT, 'test', 'fixtures', 'sample.jsonl'), 'utf8');
      const extras = {
        SessionStart: { source: 'startup', model: 'claude-test-1' },
        UserPromptSubmit: { prompt: '버튼 색을 바꿔 주세요' },
        PreToolUse: { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '어느 색?' }] } },
        PostToolUse: { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a' } },
        PostToolUseFailure: { tool_name: 'Bash', tool_input: { command: 'false' }, error: '실패', is_interrupt: false },
        Notification: { notification_type: 'permission_prompt', message: '승인이 필요합니다' },
        Stop: { stop_hook_active: false, last_assistant_message: '끝났습니다' },
        StopFailure: { error: 'rate_limit', error_details: '한도 초과' },
        SubagentStop: { agent_id: 'a-1', agent_type: 'Explore' },
        SessionEnd: { reason: 'exit' },
      };
      for (const event of HOOK_EVENTS) {
        appendFileSync(transcript, fixture.replace(/\n/g, '\r\n'));
        const r = await runNode(BIN('hook.mjs'), [], {
          env: sb.env,
          input: JSON.stringify({ session_id: 'sess-1', transcript_path: transcript, cwd: 'C:\\work\\x', hook_event_name: event, ...extras[event] }),
        });
        expect(r.code).toBe(0);
        expect(r.stdout.length).toBe(0);
      }
      expect(server.requests).toHaveLength(HOOK_EVENTS.length);
      for (const [i, q] of server.requests.entries()) {
        const parsed = IngestBatchSchema.safeParse(q.body);
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
        expect(q.body.events[0].event).toBe(HOOK_EVENTS[i]);
        expect(q.body.events[0].cwd).toBe('C:\\work\\x');
        expect(q.body.transcript[0].seq).toBe(i * 7); // 견본 하나가 7줄
        expect(q.body.transcript[0].lines).toHaveLength(7);
      }
      // 상태 규칙이 쓰는 필드가 data에 그대로 들어 있다.
      const dataOf = (name) => server.requests[HOOK_EVENTS.indexOf(name)].body.events[0].data;
      expect(dataOf('PreToolUse').tool_name).toBe('AskUserQuestion');
      expect(dataOf('Notification').notification_type).toBe('permission_prompt');
      expect(dataOf('StopFailure').error).toBe('rate_limit');
      expect(server.requests[0].body.events[0].model).toBe('claude-test-1');
    } finally { await server.close(); }
  });

  it('원격 제어 주소(remoteUrl)가 있는 이벤트도 IngestBatchSchema를 통과한다', async () => {
    const server = await startServer();
    try {
      connect(server.url);
      for (const id of ['session_01AbC-dEf_9', '이상한 값']) {
        await runNode(BIN('hook.mjs'), [], {
          env: { ...sb.env, CLAUDE_CODE_BRIDGE_SESSION_ID: id },
          input: JSON.stringify({ session_id: 'sess-1', cwd: 'C:\\work\\x', hook_event_name: 'Stop' }),
        });
      }
      expect(server.requests.map((q) => q.body.events[0].remoteUrl)).toEqual(['https://claude.ai/code/session_01AbC-dEf_9', null]);
      for (const q of server.requests) {
        const parsed = IngestBatchSchema.safeParse(q.body);
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      }
    } finally { await server.close(); }
  });

  it('원격 답장 등록·대기 본문이 ReplyAskSchema·ReplyWaitSchema를 통과한다', async () => {
    const server = await startServer((req) => (req.url === '/api/reply/ask'
      ? { status: 200, json: { requestId: 'req-1' } }
      : { status: 200, json: { status: 'gone' } }));
    try {
      connect(server.url);
      const base = { session_id: 'sess-1', cwd: 'C:\\work\\x', permission_mode: 'default', hook_event_name: 'PermissionRequest' };
      const long = '가'.repeat(5000);
      const inputs = [
        {
          ...base, tool_name: 'Bash', tool_input: { command: 'npm run build' }, agent_id: 'agent-7',
          permission_suggestions: [
            { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run:*' }], behavior: 'allow', destination: 'localSettings' },
            { type: 'addDirectories', directories: ['C:\\work\\' + 'y'.repeat(900)], destination: 'session' },
            { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
          ],
        },
        { ...base, tool_name: 'Write', tool_input: { file_path: 'a.txt', content: long.repeat(4) } },
        { ...base, tool_name: 'mcp__x__' + 'y'.repeat(400) },
        {
          ...base, tool_name: 'AskUserQuestion',
          tool_input: {
            questions: [
              { question: '어느 색?', header: '색', multiSelect: false, options: [{ label: '파랑', description: '차분함' }, { label: '빨강' }] },
              { question: long, header: long, multiSelect: true, options: Array.from({ length: 14 }, (_, i) => ({ label: `${i} ${long}`, description: long })) },
              ...Array.from({ length: 5 }, (_, i) => ({ question: `덤 ${i}`, options: [] })),
            ],
          },
        },
      ];
      for (const input of inputs) {
        const r = await runNode(BIN('ask.mjs'), [], { env: sb.env, input: JSON.stringify(input) });
        expect(r.code).toBe(0);
        expect(r.stdout.length).toBe(0);
      }
      const asks = server.requests.filter((q) => q.url === '/api/reply/ask');
      const waits = server.requests.filter((q) => q.url === '/api/reply/wait');
      expect(asks).toHaveLength(inputs.length);
      expect(waits).toHaveLength(inputs.length);
      for (const q of asks) {
        const parsed = ReplyAskSchema.safeParse(q.body);
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
        expect(Object.keys(parsed.data).sort()).toEqual(Object.keys(q.body).sort()); // 계약에 없는 필드를 보내지 않는다
      }
      expect(asks.map((q) => q.body.kind)).toEqual(['permission', 'permission', 'permission', 'question']);
      expect(asks[0].body.agentId).toBe('agent-7');
      expect(asks[3].body.questions).toHaveLength(4);
      for (const q of waits) {
        const parsed = ReplyWaitSchema.safeParse(q.body);
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
        expect(q.body).toEqual({ requestId: 'req-1' });
      }
    } finally { await server.close(); }
  });

  it('계약(ReplyAnswerSchema)을 통과하는 답은 모두 클로드코드 훅 출력으로 바뀐다', async () => {
    const answers = [
      { type: 'permission', behavior: 'allow' },
      { type: 'permission', behavior: 'allow_session' },
      { type: 'permission', behavior: 'deny' },
      { type: 'permission', behavior: 'deny', message: '가'.repeat(MESSAGE_MAX_CHARS) },
    ];
    for (const answer of answers) {
      expect(ReplyAnswerSchema.safeParse(answer).success).toBe(true);
      const server = await startServer((req) => (req.url === '/api/reply/ask'
        ? { status: 200, json: { requestId: 'req-1' } }
        : { status: 200, json: { status: 'answered', answer } }));
      try {
        connect(server.url);
        const r = await runNode(BIN('ask.mjs'), [], {
          env: sb.env,
          input: JSON.stringify({ session_id: 'sess-1', cwd: 'C:\\work\\x', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }),
        });
        expect(r.code).toBe(0);
        const out = JSON.parse(r.stdout.toString('utf8'));
        expect(out.hookSpecificOutput.hookEventName).toBe('PermissionRequest');
        expect(out.hookSpecificOutput.decision.behavior).toBe(answer.behavior === 'deny' ? 'deny' : 'allow');
      } finally { await server.close(); }
    }
  });

  it('글 받기 본문이 ReplyInboxSchema를 통과한다', async () => {
    const server = await startServer(() => ({ status: 200, json: { status: 'gone' } }));
    try {
      connect(server.url);
      for (const event of ['Stop', 'SessionStart']) {
        const r = await runNode(BIN('inbox.mjs'), [], {
          env: sb.env, input: JSON.stringify({ session_id: 'sess-1', cwd: 'C:\\work\\x', hook_event_name: event }),
        });
        expect(r.code).toBe(0);
      }
      expect(server.requests.map((q) => q.url)).toEqual(['/api/reply/inbox', '/api/reply/inbox']);
      for (const q of server.requests) {
        const parsed = ReplyInboxSchema.safeParse(q.body);
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
        expect(Object.keys(parsed.data).sort()).toEqual(Object.keys(q.body).sort());
      }
    } finally { await server.close(); }
  });

  it('상태줄 래퍼의 전송 본문이 IngestBatchSchema를 통과한다', async () => {
    const server = await startServer();
    try {
      connect(server.url);
      mkdirSync(join(sb.statusHome, 'bin'), { recursive: true });
      const wrapper = join(sb.statusHome, 'bin', 'statusline.mjs');
      copyFileSync(BIN('statusline.mjs'), wrapper);
      for (const rate_limits of [
        { five_hour: { used_percentage: 41.5, resets_at: 1794000000 }, seven_day: { used_percentage: 12, resets_at: 1794500000 } },
        { seven_day: { used_percentage: 99.9 } },
      ]) {
        rmSync(join(sb.statusHome, 'state'), { recursive: true, force: true }); // 60초 제한을 풀고 다시 보내게 한다
        await runNode(wrapper, [], { env: sb.env, input: JSON.stringify({ session_id: 's', rate_limits }) });
      }
      expect(server.requests).toHaveLength(2);
      for (const q of server.requests) {
        const parsed = IngestBatchSchema.safeParse(q.body);
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      }
    } finally { await server.close(); }
  });

  it('상태줄 래퍼의 세션 통계(sessionStats)가 기대 모양을 통과하고, 계약에 없는 필드는 보내지 않는다', async () => {
    const server = await startServer();
    try {
      connect(server.url);
      mkdirSync(join(sb.statusHome, 'bin'), { recursive: true });
      const wrapper = join(sb.statusHome, 'bin', 'statusline.mjs');
      copyFileSync(BIN('statusline.mjs'), wrapper);
      const inputs = [
        // 한도와 함께
        {
          session_id: 's-1', rate_limits: { five_hour: { used_percentage: 41.5, resets_at: 1794000000 } },
          context_window: { used_percentage: 37.26, context_window_size: 200000 }, cost: { total_cost_usd: 1.2345 },
        },
        // 계산으로 구한 컨텍스트, 비용 없음
        { session_id: 's-2', context_window: { context_window_size: 1000, current_usage: { input_tokens: 1, cache_read_input_tokens: 2 } } },
        // 컨텍스트 없음, 비용만, 아주 긴 세션 id
        { session_id: 'x'.repeat(500), cost: { total_cost_usd: 0 } },
        // 범위를 벗어난 값
        { session_id: 's-4', context_window: { used_percentage: 1e9 }, cost: { total_cost_usd: 1e6 } },
      ];
      for (const input of inputs) {
        rmSync(join(sb.statusHome, 'state', 'limits.json'), { force: true });
        await runNode(wrapper, [], { env: sb.env, input: JSON.stringify(input) });
      }
      expect(server.requests).toHaveLength(inputs.length);
      for (const q of server.requests) {
        const parsed = IngestWithStatsSchema.safeParse(q.body);
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
        expect(q.body.sessionStats).toHaveLength(1);
        for (const s of q.body.sessionStats) {
          const one = SessionStatSchema.strict().safeParse(s);
          expect(one.success, JSON.stringify(one.error?.issues)).toBe(true);
          if (s.contextPct !== null) expect(Math.round(s.contextPct * 10) / 10).toBe(s.contextPct);
        }
      }
      expect(server.requests[0].body.limits).toBeDefined();
      expect(server.requests.map((q) => q.body.sessionStats[0].contextPct)).toEqual([37.3, 0.3, null, 100]);
    } finally { await server.close(); }
  });

  it('글 수신 확인 본문이 기대 모양(ReplyInboxAckSchema)을 통과한다', async () => {
    const server = await startServer((req) => (req.url === '/api/reply/inbox'
      ? { status: 200, json: { status: 'message', id: 'msg-1', text: '안녕' } }
      : { status: 200, json: { ok: true } }));
    try {
      connect(server.url);
      const r = await runNode(BIN('inbox.mjs'), [], {
        env: sb.env, input: JSON.stringify({ session_id: 'sess-1', cwd: 'C:\\work\\x', hook_event_name: 'Stop' }),
      });
      expect(r.code).toBe(2);
      expect(server.requests.map((q) => q.url)).toEqual(['/api/reply/inbox', '/api/reply/inbox/ack']);
      const ack = server.requests[1];
      const parsed = ReplyInboxAckSchema.strict().safeParse(ack.body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      expect(ack.body).toEqual({ sessionId: 'sess-1', id: 'msg-1' });
    } finally { await server.close(); }
  });
});
