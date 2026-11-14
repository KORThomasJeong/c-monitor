// 클로드코드 transcript(JSONL)를 증분으로 읽어 계약의 TranscriptLine으로 바꾼다.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { maskDeep, maskSecrets } from './mask.mjs';
import { WAKE_PREFIX } from './reply.mjs';

/** 한 줄 글의 최대 크기(바이트). shared/src/contract.ts 의 MAX_LINE_BYTES 와 같아야 한다. */
export const MAX_LINE_BYTES = 64 * 1024;
/** 도구 입력(JSON)이 이보다 크면 줄인다. */
const MAX_TOOL_INPUT_BYTES = 32 * 1024;
/** 한 번에 읽는 기본 크기. 줄 하나가 이보다 길면 줄바꿈이 나올 때까지 늘린다. */
const READ_WINDOW = 8 * 1024 * 1024;

const bytes = (s) => Buffer.byteLength(s, 'utf8');

/** UTF-8 기준 max 바이트 이하로 자른다. 글자 중간에서 끊지 않는다. */
export function truncateUtf8(text, max) {
  if (bytes(text) <= max) return { text, truncated: false };
  const buf = Buffer.from(text, 'utf8');
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1; // 이어지는 바이트 위에서는 끊지 않는다
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

function isoOrNow(value) {
  const d = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

/** tool_result의 content(문자열 또는 블록 배열)를 글로 만든다. */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text' && typeof part.text === 'string') return part.text;
      if (part?.type === 'image') return '[이미지]';
      return part?.type ? `[${part.type}]` : '';
    })
    .filter((s) => s.length > 0)
    .join('\n');
}

// 카드에 보일 한 줄 요약으로 쓸 만한 입력 필드(앞에 있을수록 우선)
const SUMMARY_KEYS = ['command', 'file_path', 'path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill'];

/** 도구 입력을 한 줄로 요약한다. */
function summarizeInput(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    for (const k of SUMMARY_KEYS) {
      if (typeof input[k] === 'string' && input[k].length > 0) return input[k];
    }
    const json = JSON.stringify(input);
    return json === '{}' ? '' : json;
  }
  return '';
}

/** 너무 큰 도구 입력을 줄인다: 긴 문자열 값을 자르고, 그래도 크면 미리보기 글만 남긴다. */
function shrinkInput(input) {
  if (bytes(JSON.stringify(input) ?? '') <= MAX_TOOL_INPUT_BYTES) return { value: input, truncated: false };
  const cut = (v, depth) => {
    if (typeof v === 'string') return v.length > 2000 ? v.slice(0, 2000) + '…' : v;
    if (v === null || typeof v !== 'object' || depth > 20) return v;
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => cut(x, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x, depth + 1)]));
  };
  const smaller = cut(input, 0);
  if (bytes(JSON.stringify(smaller)) <= MAX_TOOL_INPUT_BYTES) return { value: smaller, truncated: true };
  return { value: { preview: truncateUtf8(JSON.stringify(smaller), 4096).text }, truncated: true };
}

/** 글 한 덩어리를 가리고 자른 TranscriptLine으로 만든다. */
function makeLine(role, at, rawText, extra = {}) {
  const masked = maskSecrets(rawText);
  const cut = truncateUtf8(masked.text, MAX_LINE_BYTES);
  const line = { role, at, text: cut.text };
  if (extra.toolName) line.toolName = String(extra.toolName).slice(0, 200);
  if (extra.toolInput !== undefined) line.toolInput = extra.toolInput;
  if (cut.truncated || extra.truncated) line.truncated = true;
  const count = masked.count + (extra.masked ?? 0);
  if (count > 0) line.masked = count;
  return line;
}

/** 클로드코드가 넣은 사용자 줄인가(사람이 친 글이 아님) */
function isInjected(entry) {
  return entry.promptSource === 'system' || entry.origin?.kind === 'task-notification' || entry.turnOrigin === 'task_notification';
}

/** 웹 대시보드에서 보낸 글로 세션을 깨운 줄이면 그 글만 돌려준다. 아니면 null. */
export function wakeMessage(text) {
  const at = text.indexOf(WAKE_PREFIX);
  if (at < 0) return null;
  let body = text.slice(at + WAKE_PREFIX.length).replace(/^\s+/, '');
  const end = body.lastIndexOf('</system-reminder>');
  if (end >= 0) body = body.slice(0, end);
  body = body.trim();
  return body.length > 0 ? body : null;
}

/** 그 밖의 주입된 줄은 태그를 걷어 내고 짧게(요약이 있으면 요약) */
function injectedSummary(text) {
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim();
  if (summary) return summary.slice(0, 300);
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * transcript JSONL 한 줄(파싱한 객체)을 TranscriptLine 0개 이상으로 바꾼다.
 * toolNames: tool_use id → 도구 이름. tool_result에 이름을 붙이는 데 쓴다(같은 읽기 안에서만 유지).
 */
export function convertEntry(entry, toolNames = new Map()) {
  if (!entry || typeof entry !== 'object') return [];
  // 대화 줄만 보낸다. system·attachment·api-request-blob 등은 건너뛴다.
  if (entry.type !== 'user' && entry.type !== 'assistant') return [];
  if (entry.isMeta || entry.isSidechain) return [];
  const message = entry.message;
  if (!message || typeof message !== 'object') return [];
  const at = isoOrNow(entry.timestamp);
  const content = message.content;
  const lines = [];

  if (typeof content === 'string') {
    if (content.trim().length === 0) return lines;
    // 클로드코드가 스스로 넣은 사용자 줄(훅 결과·백그라운드 작업 알림 등). 사람이 쓴 글이 아니다.
    if (entry.type === 'user' && isInjected(entry)) {
      const wake = wakeMessage(content);
      if (wake !== null) lines.push(makeLine('user', at, wake, { remote: true }));
      else lines.push(makeLine('system', at, injectedSummary(content)));
      return lines;
    }
    lines.push(makeLine(entry.type, at, content));
    return lines;
  }
  if (!Array.isArray(content)) return lines;

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text.trim().length > 0) lines.push(makeLine(entry.type, at, block.text));
    } else if (block.type === 'tool_use') {
      if (typeof block.id === 'string' && typeof block.name === 'string') toolNames.set(block.id, block.name);
      const maskedInput = maskDeep(block.input ?? {});
      const shrunk = shrinkInput(maskedInput.value);
      // 요약 글은 가린 입력에서 뽑으므로 여기서 다시 세지 않는다.
      const summary = truncateUtf8(summarizeInput(maskedInput.value), MAX_LINE_BYTES);
      const line = { role: 'tool', at, text: summary.text, toolName: String(block.name ?? 'tool').slice(0, 200), toolInput: shrunk.value };
      if (summary.truncated || shrunk.truncated) line.truncated = true;
      if (maskedInput.count > 0) line.masked = maskedInput.count;
      lines.push(line);
    } else if (block.type === 'tool_result') {
      lines.push(makeLine('tool', at, resultText(block.content), { toolName: toolNames.get(block.tool_use_id) }));
    }
    // thinking, image 등 나머지 블록은 보내지 않는다.
  }
  return lines;
}

/**
 * 파일의 state.offset(바이트) 이후를 읽어 TranscriptLine으로 바꾼다.
 * 줄바꿈으로 끝나지 않은 마지막 줄은 다음 호출로 미룬다(offset을 그 줄 앞에 둔다).
 * → {lines, state: {offset, seq}}. seq는 지금까지 만든 줄 수(다음 줄의 순번).
 */
export function readTranscriptDelta(path, state) {
  let offset = Number.isFinite(state?.offset) && state.offset >= 0 ? state.offset : 0;
  const seq = Number.isFinite(state?.seq) && state.seq >= 0 ? state.seq : 0;
  const unchanged = { lines: [], state: { offset, seq } };

  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return unchanged; // 파일이 없거나 열 수 없음
  }
  try {
    const size = fstatSync(fd).size;
    if (offset > size) offset = 0; // 파일이 줄어들었으면 처음부터
    if (size === offset) return { lines: [], state: { offset, seq } };

    // 줄바꿈이 하나라도 들어올 때까지 읽는 범위를 늘린다.
    let want = Math.min(READ_WINDOW, size - offset);
    let buf;
    let lastNewline = -1;
    for (;;) {
      buf = Buffer.allocUnsafe(want);
      const got = readSync(fd, buf, 0, want, offset);
      buf = buf.subarray(0, got);
      lastNewline = buf.lastIndexOf(0x0a);
      if (lastNewline !== -1 || got < want || offset + got >= size) break;
      want = Math.min(want * 2, size - offset);
    }
    if (lastNewline === -1) return { lines: [], state: { offset, seq } }; // 아직 완성된 줄이 없다

    const toolNames = new Map();
    const lines = [];
    for (const raw of buf.subarray(0, lastNewline).toString('utf8').split('\n')) {
      const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw; // CRLF 허용
      if (text.trim().length === 0) continue;
      let entry;
      try {
        entry = JSON.parse(text);
      } catch {
        continue; // 깨진 줄은 건너뛴다
      }
      for (const line of convertEntry(entry, toolNames)) lines.push(line);
    }
    return { lines, state: { offset: offset + lastNewline + 1, seq: seq + lines.length } };
  } catch {
    return unchanged;
  } finally {
    try { closeSync(fd); } catch { /* 무시 */ }
  }
}
