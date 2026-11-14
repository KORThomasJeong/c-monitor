// 원격 답장(2차)의 순수 함수들: 등록 본문 만들기, 웹에서 온 답을 클로드코드 훅 출력으로 바꾸기.
// 모양은 shared/src/contract.ts 의 "원격 답장(2차)" 절과 같아야 한다(플러그인은 그 파일을 import하지 않는다).
import { maskSecrets } from './mask.mjs';
import { safeToolInput } from './toolinput.mjs';

// 계약의 길이 제한
const MAX_SESSION_ALLOW = 500;
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 10;

/** 깨우는 글의 머리말(계획의 동작 규칙 5) */
export const WAKE_PREFIX = '[c-monitor] 사용자가 웹 대시보드에서 보낸 메시지입니다. 사용자의 다음 요청으로 받아들여 처리하세요.';
export const DENY_DEFAULT = '사용자가 웹 대시보드에서 거부했습니다.';
export const DENY_WITH_TEXT = '사용자가 웹 대시보드에서 거부하고 이렇게 말했습니다: ';

const MODE_TEXT = {
  acceptEdits: '이 세션 동안 파일 수정 자동 허용',
  plan: '이 세션을 계획 모드로 전환',
  default: '이 세션을 기본 권한 모드로 전환',
};

/** 제안 하나를 사람이 읽을 한 줄로. 설명할 수 없는 제안이면 null. */
function describeSuggestion(s) {
  if (!s || typeof s !== 'object') return null;
  if (s.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules) && s.rules.length > 0) {
    const names = [];
    for (const rule of s.rules) {
      if (!rule || typeof rule.toolName !== 'string' || rule.toolName.length === 0) return null;
      const content = typeof rule.ruleContent === 'string' && rule.ruleContent.length > 0 ? `(${rule.ruleContent})` : '';
      names.push('`' + rule.toolName + content + '`');
    }
    return `이 세션 동안 ${names.join(', ')} 허용`;
  }
  if (s.type === 'addDirectories' && Array.isArray(s.directories) && s.directories.length > 0
    && s.directories.every((d) => typeof d === 'string' && d.length > 0)) {
    return `이 세션 동안 ${s.directories.join(', ')} 접근 허용`;
  }
  if (s.type === 'setMode' && typeof s.mode === 'string' && Object.hasOwn(MODE_TEXT, s.mode)) return MODE_TEXT[s.mode];
  return null;
}

/**
 * "이 세션 동안 허용"에 쓸 제안만 고른다 — 사람에게 설명할 수 있는 것만(설명한 것과 실제로 적용되는 것이 같아야 한다).
 * 규칙 삭제·거부 규칙·승인 건너뛰기 모드처럼 설명하지 못하는 제안은 쓰지 않는다.
 */
function usableSuggestions(suggestions) {
  return Array.isArray(suggestions) ? suggestions.filter((s) => describeSuggestion(s) !== null) : [];
}

/** permission_suggestions → "이 세션 동안 허용"이 하는 일을 설명한 한 줄(여러 개면 " · "로 잇는다). 쓸 제안이 없으면 null. */
export function describeSessionAllow(suggestions) {
  const lines = usableSuggestions(suggestions).map(describeSuggestion);
  if (lines.length === 0) return null;
  const text = maskSecrets(lines.join(' · ')).text;
  return text.length > MAX_SESSION_ALLOW ? text.slice(0, MAX_SESSION_ALLOW - 1) + '…' : text;
}

/** allow_session 으로 답할 때 돌려줄 updatedPermissions: 쓸 제안의 destination 을 "session"으로 바꾼 것. */
export function sessionPermissions(suggestions) {
  return usableSuggestions(suggestions).map((s) => ({ ...s, destination: 'session' }));
}

/** 글을 가리고 max 자로 줄인다. */
const clip = (text, max) => {
  const masked = maskSecrets(text).text;
  return masked.length > max ? masked.slice(0, max - 1) + '…' : masked;
};

/**
 * AskUserQuestion 의 tool_input.questions 를 계약 모양(ReplyQuestion[])으로 추린다. 쓸 질문이 없으면 null.
 * 서버로는 가리고 줄인 글을 보내지만 클로드코드에는 원래 글로 답해야 하므로, 되돌리는 함수(restore)를 함께 준다.
 */
export function pickQuestions(toolInput) {
  const list = toolInput && typeof toolInput === 'object' && Array.isArray(toolInput.questions) ? toolInput.questions : [];
  const questions = [];
  /** 보낸 질문 글 → {원래 질문 글, 보낸 label → 원래 label} */
  const sent = new Map();
  for (const q of list) {
    if (questions.length >= MAX_QUESTIONS) break;
    if (!q || typeof q !== 'object' || typeof q.question !== 'string' || q.question.length === 0) continue;
    const question = clip(q.question, 2000);
    if (sent.has(question)) continue;
    const item = { question };
    if (typeof q.header === 'string') item.header = clip(q.header, 200);
    if (typeof q.multiSelect === 'boolean') item.multiSelect = q.multiSelect;
    const labels = new Map();
    item.options = [];
    for (const o of Array.isArray(q.options) ? q.options : []) {
      if (item.options.length >= MAX_OPTIONS) break;
      if (!o || typeof o !== 'object' || typeof o.label !== 'string' || o.label.length === 0) continue;
      const option = { label: clip(o.label, 500) };
      if (typeof o.description === 'string') option.description = clip(o.description, 2000);
      if (!labels.has(option.label)) labels.set(option.label, o.label);
      item.options.push(option);
    }
    sent.set(question, { original: q.question, labels });
    questions.push(item);
  }
  if (questions.length === 0) return null;

  /** 웹에서 온 answers(보낸 글 기준)를 원래 질문 글·원래 label 기준으로 되돌린다. */
  const restore = (answers) => {
    const out = {};
    for (const [key, value] of Object.entries(answers)) {
      if (typeof value !== 'string') continue;
      const q = sent.get(key);
      if (!q) {
        out[key] = value;
        continue;
      }
      let answer = value;
      if (q.labels.has(value)) answer = q.labels.get(value);
      else {
        // 여러 개를 고른 답은 ", "로 이어져 온다. 모두 선택지일 때만 바꾼다(직접 쓴 답은 그대로).
        const parts = value.split(', ');
        if (parts.length > 1 && parts.every((p) => q.labels.has(p))) answer = parts.map((p) => q.labels.get(p)).join(', ');
      }
      out[q.original] = answer;
    }
    return out;
  };
  return { questions, restore };
}

/**
 * PermissionRequest 훅 입력 → POST /api/reply/ask 본문. 입력이 이상하면 null.
 * → {body, kind, restore}
 */
export function buildAsk(input) {
  if (!input || typeof input !== 'object' || input.hook_event_name !== 'PermissionRequest') return null;
  const sessionId = typeof input.session_id === 'string' ? input.session_id.slice(0, 200) : '';
  const toolName = typeof input.tool_name === 'string' ? input.tool_name.slice(0, 200) : '';
  if (sessionId.length === 0 || toolName.length === 0) return null;

  const body = {
    sessionId,
    kind: 'permission',
    toolName,
    toolInput: safeToolInput(input.tool_input) ?? null,
    agentId: typeof input.agent_id === 'string' && input.agent_id.length > 0 ? input.agent_id.slice(0, 200) : null,
    sessionAllow: null,
    at: new Date().toISOString(),
  };
  if (toolName === 'AskUserQuestion') {
    const picked = pickQuestions(input.tool_input);
    if (!picked) return null; // 질문을 읽지 못하면 웹에서 답할 수 없다 — 터미널에 맡긴다
    body.kind = 'question';
    body.questions = picked.questions;
    return { body, kind: 'question', restore: picked.restore };
  }
  body.sessionAllow = describeSessionAllow(input.permission_suggestions);
  return { body, kind: 'permission', restore: null };
}

/**
 * 웹에서 온 답(ReplyAnswer) → 클로드코드에 돌려줄 훅 출력. 쓸 수 없는 답이면 null(아무것도 출력하지 않는다).
 * input 은 가리지 않은 원래 훅 입력이다.
 */
export function buildDecision(input, ask, answer) {
  const out = (decision) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
  if (!answer || typeof answer !== 'object') return null;

  if (answer.type === 'permission') {
    if (answer.behavior === 'deny') {
      const said = typeof answer.message === 'string' ? answer.message.trim() : '';
      return out({ behavior: 'deny', message: said.length > 0 ? DENY_WITH_TEXT + said : DENY_DEFAULT });
    }
    if (ask.kind !== 'permission') return null; // 질문은 답 없이 허용할 수 없다
    if (answer.behavior === 'allow') return out({ behavior: 'allow' });
    if (answer.behavior === 'allow_session') {
      const updatedPermissions = sessionPermissions(input.permission_suggestions);
      return out(updatedPermissions.length > 0 ? { behavior: 'allow', updatedPermissions } : { behavior: 'allow' });
    }
    return null;
  }

  if (answer.type === 'answer' && ask.kind === 'question') {
    if (!answer.answers || typeof answer.answers !== 'object' || Array.isArray(answer.answers)) return null;
    const answers = ask.restore(answer.answers);
    if (Object.keys(answers).length === 0) return null;
    return out({ behavior: 'allow', updatedInput: { ...input.tool_input, answers } });
  }
  return null;
}

/** 깨우는 글(inbox.mjs가 stderr에 쓴다). */
export const wakeText = (text) => `${WAKE_PREFIX}\n\n${text}`;
