// 플러그인이 만든 JSON이 공용 계약(shared/src/contract.ts)을 실제로 통과하는지 확인한다.
// 플러그인 코드는 계약 파일을 import하지 않지만(런타임 의존성 0), 테스트에서는 같은 스키마로 검증한다.
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOOK_EVENTS, IngestBatchSchema, MAX_BATCH_BYTES, MAX_LINE_BYTES } from '../../shared/src/contract.ts';
import * as queue from '../lib/queue.mjs';
import * as transcriptLib from '../lib/transcript.mjs';
import { BIN, PLUGIN_ROOT, makeSandbox, runNode, startServer } from './helpers.mjs';

let sb;
beforeEach(() => {
  sb = makeSandbox();
  writeFileSync(join(sb.configDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'dev@example.com' } }));
});
afterEach(() => sb.cleanup());

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
    expect(Object.keys(hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    for (const groups of Object.values(hooks)) {
      expect(groups).toHaveLength(1);
      expect(groups[0].matcher).toBeUndefined();
      expect(groups[0].hooks).toEqual([
        { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/hook.mjs"', async: true, timeout: 10 },
      ]);
    }
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
});
