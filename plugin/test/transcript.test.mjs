import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_LINE_BYTES, convertEntry, readTranscriptDelta } from '../lib/transcript.mjs';
import { PLUGIN_ROOT, makeSandbox } from './helpers.mjs';

const FIXTURE = join(PLUGIN_ROOT, 'test', 'fixtures', 'sample.jsonl');
const START = { offset: 0, seq: 0 };

const userLine = (text, at = '2026-11-14T08:00:00.000Z') =>
  JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: text }, timestamp: at, cwd: 'C:\\work\\x' });
const assistantLine = (text, at = '2026-11-14T08:00:01.000Z') =>
  JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: at });

let sb;
let file;
beforeEach(() => { sb = makeSandbox(); file = join(sb.root, 'session.jsonl'); });
afterEach(() => sb.cleanup());

describe('convertEntry', () => {
  it('견본 transcript를 계약의 TranscriptLine으로 바꾼다', () => {
    const { lines, state } = readTranscriptDelta(FIXTURE, START);
    expect(lines.map((l) => l.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'tool', 'tool', 'assistant']);
    expect(lines[0]).toEqual({ role: 'user', at: '2026-11-14T08:00:00.000Z', text: '로그인 화면 버튼 색을 바꿔 주세요' });
    expect(lines[1].text).toBe('버튼 스타일 파일을 먼저 찾아보겠습니다.');
    // tool_use: 이름·입력·요약
    expect(lines[2].toolName).toBe('Bash');
    expect(lines[2].toolInput.command).toBe('grep -rn "btn-primary" C:\\work\\x\\src');
    expect(lines[2].text).toBe('grep -rn "btn-primary" C:\\work\\x\\src');
    // tool_result: 글자 결과
    expect(lines[3].text).toBe('src/styles/app.css:12:.btn-primary { color: blue; }');
    expect(lines[3].toolName).toBe('Bash'); // 같은 읽기 안의 tool_use에서 이름을 찾아 붙인다
    expect(lines[4].toolName).toBe('Read');
    expect(lines[4].text).toBe('C:\\work\\x\\src\\styles\\app.css');
    // 배열 결과: 글은 잇고 그림은 표시만
    expect(lines[5].text).toBe('1\t.btn-primary { color: blue; }\n[이미지]');
    expect(state.seq).toBe(7);
    expect(state.offset).toBe(readFileSync(FIXTURE).length);
  });

  it('시스템 줄·메타 줄·사이드체인·생각 블록은 건너뛴다', () => {
    expect(convertEntry({ type: 'system', subtype: 'turn_duration', timestamp: '2026-11-14T08:00:00Z' })).toEqual([]);
    expect(convertEntry({ type: 'user', isMeta: true, message: { role: 'user', content: '안내' } })).toEqual([]);
    expect(convertEntry({ type: 'user', isSidechain: true, message: { role: 'user', content: '하위' } })).toEqual([]);
    expect(convertEntry({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '음' }] } })).toEqual([]);
    expect(convertEntry({ type: 'api-request-blob', message: { role: 'user', content: [{ type: 'text', text: '사본' }] } })).toEqual([]);
    expect(convertEntry(null)).toEqual([]);
    expect(convertEntry('글자')).toEqual([]);
  });

  it('글과 도구 입력의 비밀을 가리고 개수를 masked에 넣는다', () => {
    const key = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const [u] = convertEntry({ type: 'user', message: { role: 'user', content: `키는 ${key} 입니다` }, timestamp: '2026-11-14T08:00:00Z' });
    expect(u.text).toBe('키는 •••••••• 입니다');
    expect(u.masked).toBe(1);
    const [t] = convertEntry({
      type: 'assistant', timestamp: '2026-11-14T08:00:00Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: `export GH=${key}` } }] },
    });
    expect(t.toolInput.command).toBe('export GH=••••••••');
    expect(t.text).toBe('export GH=••••••••');
    expect(t.masked).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(t)).not.toContain(key);
  });

  it('시각이 없거나 이상하면 현재 시각(ISO)을 넣는다', () => {
    const [l] = convertEntry({ type: 'user', message: { role: 'user', content: '안녕' }, timestamp: '이상한 값' });
    expect(new Date(l.at).toISOString()).toBe(l.at);
  });
});

describe('readTranscriptDelta', () => {
  it('없는 파일이면 빈 결과와 같은 상태를 돌려준다', () => {
    const r = readTranscriptDelta(join(sb.root, '없음.jsonl'), { offset: 5, seq: 2 });
    expect(r).toEqual({ lines: [], state: { offset: 5, seq: 2 } });
  });

  it('이전 위치 이후만 읽고 seq를 이어 간다', () => {
    writeFileSync(file, userLine('첫 번째') + '\n' + assistantLine('두 번째') + '\n');
    const a = readTranscriptDelta(file, START);
    expect(a.lines.map((l) => l.text)).toEqual(['첫 번째', '두 번째']);
    expect(a.state.seq).toBe(2);

    const again = readTranscriptDelta(file, a.state);
    expect(again.lines).toEqual([]);
    expect(again.state).toEqual(a.state);

    appendFileSync(file, userLine('세 번째') + '\n');
    const b = readTranscriptDelta(file, a.state);
    expect(b.lines.map((l) => l.text)).toEqual(['세 번째']);
    expect(b.state.seq).toBe(3);
  });

  it('CRLF 줄끝과 Windows 경로가 들어 있어도 깨지지 않는다', () => {
    writeFileSync(file, userLine('C:\\work\\x 폴더를 봐 주세요') + '\r\n' + assistantLine('C:\\work\\x\\a.txt 를 읽었습니다') + '\r\n');
    const r = readTranscriptDelta(file, START);
    expect(r.lines.map((l) => l.text)).toEqual(['C:\\work\\x 폴더를 봐 주세요', 'C:\\work\\x\\a.txt 를 읽었습니다']);
    expect(r.state.offset).toBe(readFileSync(file).length);
  });

  it('덜 써진 마지막 줄은 다음 호출로 미룬다', () => {
    const full = assistantLine('한글이 들어간 긴 답변입니다');
    const cut = Math.floor(Buffer.byteLength(full) / 2) + 1; // 한글 바이트 중간일 수도 있는 위치
    const head = Buffer.from(full).subarray(0, cut);
    const tail = Buffer.from(full).subarray(cut);
    writeFileSync(file, Buffer.concat([Buffer.from(userLine('질문') + '\r\n'), head]));

    const a = readTranscriptDelta(file, START);
    expect(a.lines.map((l) => l.text)).toEqual(['질문']);
    expect(a.state.offset).toBe(Buffer.byteLength(userLine('질문') + '\r\n'));

    // 아직 줄바꿈이 없으면 계속 미룬다.
    appendFileSync(file, tail);
    const b = readTranscriptDelta(file, a.state);
    expect(b.lines).toEqual([]);
    expect(b.state).toEqual(a.state);

    appendFileSync(file, '\r\n');
    const c = readTranscriptDelta(file, b.state);
    expect(c.lines.map((l) => l.text)).toEqual(['한글이 들어간 긴 답변입니다']);
    expect(c.state.seq).toBe(2);
  });

  it('JSON이 깨진 줄과 빈 줄은 건너뛰고 계속 읽는다', () => {
    writeFileSync(file, userLine('하나') + '\n{깨진 줄\n\n' + userLine('둘') + '\n');
    const r = readTranscriptDelta(file, START);
    expect(r.lines.map((l) => l.text)).toEqual(['하나', '둘']);
  });

  it('64KB를 넘는 글은 잘라서 truncated를 붙인다(한글이 중간에 깨지지 않게)', () => {
    const big = '가'.repeat(40_000); // UTF-8로 120KB
    writeFileSync(file, userLine(big) + '\n' + userLine('짧은 글') + '\n');
    const r = readTranscriptDelta(file, START);
    expect(r.lines[0].truncated).toBe(true);
    expect(Buffer.byteLength(r.lines[0].text)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(r.lines[0].text).toMatch(/^가+$/);
    expect(r.lines[1].truncated).toBeUndefined();
  });

  it('너무 큰 도구 입력도 잘라서 truncated를 붙인다', () => {
    const entry = { type: 'assistant', timestamp: '2026-11-14T08:00:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'C:\\work\\x\\big.txt', content: 'x'.repeat(200_000) } }] } };
    writeFileSync(file, JSON.stringify(entry) + '\n');
    const [l] = readTranscriptDelta(file, START).lines;
    expect(l.truncated).toBe(true);
    expect(l.text).toBe('C:\\work\\x\\big.txt');
    expect(Buffer.byteLength(JSON.stringify(l))).toBeLessThan(MAX_LINE_BYTES + 2048);
  });

  it('파일이 줄어들었으면 처음부터 다시 읽는다', () => {
    writeFileSync(file, userLine('새로 쓴 파일') + '\n');
    const r = readTranscriptDelta(file, { offset: 99_999, seq: 10 });
    expect(r.lines.map((l) => l.text)).toEqual(['새로 쓴 파일']);
    expect(r.state.offset).toBe(readFileSync(file).length);
    expect(r.state.seq).toBe(11);
  });
});

describe('클로드코드가 넣은 사용자 줄', () => {
  const at = '2026-11-14T13:29:43.035Z';
  const injected = (content) => ({ type: 'user', promptSource: 'system', origin: { kind: 'task-notification' }, timestamp: at, message: { role: 'user', content } });

  it('웹에서 보낸 글로 깨운 줄은 그 글만 사용자 줄로 남긴다', () => {
    const content = '<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\n'
      + 'Stop hook blocking error from command "Stop": [c-monitor] 사용자가 웹 대시보드에서 보낸 메시지입니다. 사용자의 다음 요청으로 받아들여 처리하세요.\n\n'
      + '테스트를 돌려 줘\n둘째 줄\n</system-reminder>';
    expect(convertEntry(injected(content))).toEqual([{ role: 'user', at, text: '테스트를 돌려 줘\n둘째 줄' }]);
  });

  it('그 밖의 주입 줄은 태그를 걷어 낸 시스템 줄로', () => {
    expect(convertEntry(injected('<task-notification><summary>Background command finished</summary></task-notification>')))
      .toEqual([{ role: 'system', at, text: 'Background command finished' }]);
    expect(convertEntry(injected('<system-reminder>\n어떤   알림\n</system-reminder>')))
      .toEqual([{ role: 'system', at, text: '어떤 알림' }]);
  });

  it('사람이 친 글은 그대로', () => {
    expect(convertEntry({ type: 'user', timestamp: at, message: { role: 'user', content: '<b>태그</b> 그대로' } }))
      .toEqual([{ role: 'user', at, text: '<b>태그</b> 그대로' }]);
  });
});
