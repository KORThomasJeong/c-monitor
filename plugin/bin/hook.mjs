#!/usr/bin/env node
// 훅 진입점. 클로드코드가 훅 이벤트마다 stdin으로 JSON을 넘겨 실행한다.
// 원칙: 클로드코드를 절대 막지 않는다 — stdout에 아무것도 쓰지 않고, 항상 0으로, 3초 조금 넘는 시간 안에 끝난다.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { hostname, platform, release } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readAccount } from '../lib/account.mjs';
import { loadConfig, pluginVersion, readJson, stateDir, writeJsonAtomic } from '../lib/config.mjs';
import { maskDeep } from '../lib/mask.mjs';
import { enqueue, flush, splitBatches } from '../lib/queue.mjs';
import { postJson } from '../lib/send.mjs';
import { readTranscriptDelta } from '../lib/transcript.mjs';

const STARTED = Date.now();
/** 전송에 쓸 수 있는 시간. 이 시각이 지나면 남은 큐는 다음 훅으로 미룬다. */
const DEADLINE = STARTED + 3000;
const REQUEST_TIMEOUT_MS = 3000;

// shared/src/contract.ts 의 HOOK_EVENTS 와 같아야 한다.
const HOOK_EVENTS = new Set([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'Notification', 'Stop', 'StopFailure', 'SubagentStop', 'SessionEnd',
]);

// 서버로 보내는 이벤트별 필드. tool_response는 보내지 않는다(대화 기록으로 간다).
const DATA_FIELDS = [
  'prompt', 'tool_name', 'tool_input', 'tool_use_id', 'notification_type', 'message', 'title',
  'last_assistant_message', 'error', 'error_details', 'is_interrupt', 'reason', 'source',
  'stop_hook_active', 'permission_mode', 'agent_id', 'agent_type',
];
const MAX_DATA_STRING = 4000;
const MAX_TOOL_INPUT_BYTES = 8 * 1024;

/** stdin 전체를 읽는다. 입력이 안 오면 1초 뒤 포기한다. */
function readStdin() {
  return new Promise((done) => {
    const chunks = [];
    const finish = () => done(Buffer.concat(chunks).toString('utf8'));
    const timer = setTimeout(finish, 1000);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => { clearTimeout(timer); finish(); });
    process.stdin.on('error', () => { clearTimeout(timer); finish(); });
  });
}

/** cwd에서 위로 올라가며 .git/HEAD를 찾아 브랜치 이름을 읽는다(프로세스 실행 없이). 못 찾으면 null. */
function readBranch(cwd) {
  try {
    if (typeof cwd !== 'string' || cwd.length === 0) return null;
    let dir = resolve(cwd);
    for (let i = 0; i < 40; i++) {
      const dotGit = join(dir, '.git');
      if (existsSync(dotGit)) {
        let headPath = join(dotGit, 'HEAD');
        if (statSync(dotGit).isFile()) {
          // 워크트리·서브모듈: ".git" 파일 안에 "gitdir: <경로>"
          const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
          if (!m) return null;
          const gitDir = m[1].trim();
          headPath = join(isAbsolute(gitDir) ? gitDir : resolve(dir, gitDir), 'HEAD');
        }
        const head = readFileSync(headPath, 'utf8').trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        if (ref) return ref[1].slice(0, 300);
        return /^[0-9a-f]{7,}$/i.test(head) ? head.slice(0, 7) : null; // 분리된 HEAD는 짧은 커밋 해시
      }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch { /* 읽지 못하면 없는 것으로 */ }
  return null;
}

function readModel(input) {
  const m = input.model;
  if (typeof m === 'string' && m.length > 0) return m.slice(0, 200);
  if (m && typeof m === 'object' && typeof m.id === 'string') return m.id.slice(0, 200);
  return null;
}

/** 이벤트별 필드만 골라 비밀을 가리고 크기를 줄인다. */
function buildData(input) {
  const picked = {};
  for (const key of DATA_FIELDS) {
    if (input[key] !== undefined && input[key] !== null) picked[key] = input[key];
  }
  const data = maskDeep(picked).value;
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && value.length > MAX_DATA_STRING) data[key] = value.slice(0, MAX_DATA_STRING) + '…';
  }
  if (data.tool_input !== undefined && Buffer.byteLength(JSON.stringify(data.tool_input)) > MAX_TOOL_INPUT_BYTES) {
    // 큰 입력(파일 내용 등)은 요약만 보낸다. 전체는 대화 기록에 있다.
    data.tool_input = { preview: JSON.stringify(data.tool_input).slice(0, 2000) + '…' };
  }
  return data;
}

function machineInfo(cfg) {
  return {
    name: String(cfg.machineName || hostname() || 'unknown').slice(0, 100),
    os: `${platform()} ${release()}`.slice(0, 100),
    pluginVersion: pluginVersion().slice(0, 40),
  };
}

const sessionStatePath = (sessionId) => join(stateDir(), `session-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)}.json`);

async function main() {
  const raw = await readStdin();
  const cfg = loadConfig();
  if (!cfg) return; // 연결 전이면 아무것도 하지 않는다

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  if (!input || typeof input !== 'object') return;
  const eventName = input.hook_event_name;
  const sessionId = typeof input.session_id === 'string' ? input.session_id.slice(0, 200) : '';
  if (!HOOK_EVENTS.has(eventName) || sessionId.length === 0) return;

  const cwd = typeof input.cwd === 'string' ? input.cwd : '';
  const event = {
    id: randomUUID(),
    sessionId,
    event: eventName,
    at: new Date().toISOString(),
    account: readAccount(),
    cwd: cwd.slice(0, 2000),
    branch: readBranch(cwd),
    model: readModel(input),
    data: buildData(input),
  };

  // 대화 기록 증분
  const statePath = sessionStatePath(sessionId);
  const transcript = [];
  let nextState = null;
  if (typeof input.transcript_path === 'string' && input.transcript_path.length > 0) {
    const prev = readJson(statePath) ?? { offset: 0, seq: 0 };
    // 한 번에 읽는 양에는 상한이 있으므로(큰 파일), 더 읽을 것이 없을 때까지 몇 번 이어 읽는다.
    let cursor = prev;
    const lines = [];
    for (let i = 0; i < 12; i++) {
      const delta = readTranscriptDelta(input.transcript_path, cursor);
      const advanced = delta.state.offset !== cursor.offset;
      for (const line of delta.lines) lines.push(line);
      cursor = delta.state;
      if (!advanced) break;
    }
    if (lines.length > 0) transcript.push({ sessionId, seq: cursor.seq - lines.length, lines });
    if (cursor.offset !== prev.offset || cursor.seq !== prev.seq) nextState = cursor;
  }

  // 큐에 먼저 넣고(디스크에 남기고) 읽은 위치를 저장한 뒤 보낸다.
  for (const batch of splitBatches({ events: [event], transcript })) enqueue(batch);
  if (nextState) writeJsonAtomic(statePath, nextState);

  const machine = machineInfo(cfg);
  const url = `${cfg.server.replace(/\/+$/, '')}/api/ingest`;
  await flush(async (batch) => {
    const remaining = DEADLINE - Date.now();
    if (remaining < 200) return false;
    const r = await postJson(url, { machine, ...batch }, cfg.token, Math.min(REQUEST_TIMEOUT_MS, remaining));
    if (r.ok) return true;
    // 모양이 틀렸거나 너무 큰 묶음은 다시 보내도 같으므로 버린다. 그 밖(서버 꺼짐·401·5xx)은 큐에 남긴다.
    if (r.status === 400 || r.status === 413 || r.status === 422) return 'drop';
    return false;
  }, { deadline: DEADLINE, lockWaitMs: 1500 });
}

// 무슨 일이 있어도 조용히 0으로 끝낸다.
const hardStop = setTimeout(() => process.exit(0), 3600);
hardStop.unref();
main().catch(() => {}).finally(() => process.exit(0));
