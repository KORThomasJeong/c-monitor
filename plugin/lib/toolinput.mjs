// 도구 입력(tool_input)을 서버로 보내기 전에 비밀을 가리고 크기를 줄인다.
// 훅 이벤트(bin/hook.mjs)와 원격 답장 등록(bin/ask.mjs)이 같은 규칙을 쓴다.
import { maskDeep } from './mask.mjs';

/** 서버로 보내는 글 하나의 최대 길이 */
export const MAX_DATA_STRING = 4000;
/** 도구 입력을 그대로 보내는 최대 크기(바이트). 넘으면 요약만 보낸다. */
export const MAX_TOOL_INPUT_BYTES = 8 * 1024;

/** 이미 비밀을 가린 도구 입력의 크기를 줄인다. 큰 입력(파일 내용 등)은 {preview}만 남긴다 — 전체는 대화 기록에 있다. */
export function shrinkToolInput(masked) {
  if (masked === undefined) return undefined;
  let value = masked;
  if (typeof value === 'string' && value.length > MAX_DATA_STRING) value = value.slice(0, MAX_DATA_STRING) + '…';
  const json = JSON.stringify(value);
  if (json !== undefined && Buffer.byteLength(json) > MAX_TOOL_INPUT_BYTES) return { preview: json.slice(0, 2000) + '…' };
  return value;
}

/** 원본 도구 입력 → 비밀을 가리고 줄인 것(원본은 바꾸지 않는다). */
export function safeToolInput(raw) {
  return shrinkToolInput(maskDeep(raw).value);
}
