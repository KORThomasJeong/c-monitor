// 텔레그램 알림 메시지 모양(HTML parse_mode). 사용자·세션에서 온 글은 모두 esc()를 거친다.
import type { ReplyQuestion } from '@c-monitor/shared';
import { head } from '../util';
import type { InlineKeyboard } from './telegram';

/** HTML parse_mode에서 글자 그대로 보이게 한다. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 대시보드에서 그 세션을 여는 주소. 웹은 ?session=<세션 id>를 읽어 그 세션을 연다. */
export function sessionUrl(publicUrl: string, sessionId: string): string {
  return `${publicUrl}/?session=${encodeURIComponent(sessionId)}`;
}

const link = (url: string, label: string) => `<a href="${esc(url)}">${esc(label)}</a>`;
const header = (emoji: string, name: string, machine: string) => `${emoji} <b>${esc(name || '세션')}</b> · ${esc(machine)}`;
const quote = (text: string, n: number) => (text.trim() ? `<blockquote>${esc(head(text.trim(), n))}</blockquote>` : '');
const lines = (...parts: (string | false | null | undefined)[]) => parts.filter((p): p is string => !!p).join('\n');

export const ACTIVITY_MAX = 300;
const SUMMARY_MAX = 300;
const QUESTION_MAX = 500;
const OPTION_MAX = 200;
const BUTTON_MAX = 40;

export type SessionHead = { sessionId: string; name: string; machine: string; publicUrl: string };

export function waitRequestText(h: SessionHead, r: {
  kind: 'permission' | 'question'; toolName: string; summary: string; questions: ReplyQuestion[] | null;
  buttons: boolean; optionButtons: boolean; canReply: boolean;
}): string {
  const url = sessionUrl(h.publicUrl, h.sessionId);
  if (r.kind === 'permission') {
    return lines(
      header('🙋', h.name, h.machine),
      `승인을 기다립니다 — <b>${esc(r.toolName)}</b>`,
      r.summary && `<pre>${esc(head(r.summary, SUMMARY_MAX))}</pre>`,
      r.canReply && '<i>답장으로 글을 보내면 거부하고 그 글을 클로드에게 전합니다.</i>',
      link(url, '대시보드에서 열기'),
    );
  }
  const qs = (r.questions ?? []).map((q) => lines(
    `<b>${esc(head(q.header ? `${q.header} — ${q.question}` : q.question, QUESTION_MAX))}</b>`
      + (q.multiSelect ? ' <i>(여러 개 고르기)</i>' : ''),
    ...q.options.map((o) => `• ${esc(head(o.label, OPTION_MAX))}`),
  ));
  return lines(
    header('❓', h.name, h.machine),
    '질문에 답을 기다립니다',
    ...qs,
    r.optionButtons ? '<i>버튼으로 고르거나, 답장으로 직접 쓴 답을 보낼 수 있습니다.</i>'
      : r.canReply ? '<i>답장으로 첫 질문의 답을 쓸 수 있습니다.</i>' : null,
    link(url, r.optionButtons ? '대시보드에서 열기' : '대시보드에서 답하기'),
  );
}

export function waitText(h: SessionHead, text: string): string {
  return lines(header('🙋', h.name, h.machine), '답을 기다립니다', quote(text, ACTIVITY_MAX),
    link(sessionUrl(h.publicUrl, h.sessionId), '대시보드에서 열기'));
}

export function doneText(h: SessionHead, text: string, canReply: boolean): string {
  return lines(header('✅', h.name, h.machine), '작업이 끝났습니다', quote(text, ACTIVITY_MAX),
    canReply && '<i>이 메시지에 답장하면 다음 지시로 세션에 보냅니다.</i>',
    link(sessionUrl(h.publicUrl, h.sessionId), '대시보드에서 열기'));
}

export function lostText(h: SessionHead, text: string): string {
  return lines(header('⚠️', h.name, h.machine), '연락이 끊겼습니다 — 한동안 소식이 없습니다', quote(text, ACTIVITY_MAX),
    link(sessionUrl(h.publicUrl, h.sessionId), '대시보드에서 열기'));
}

/** epoch 초 → '11월 14일 15:00'(한국 시간) */
export function kstTime(epochSec: number): string {
  const d = new Date(epochSec * 1000 + 9 * 60 * 60_000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${hh}:${mm}`;
}

export function limitText(publicUrl: string, a: {
  account: string; window: 'five' | 'seven'; pct: number; limitPct: number; resetsAt: number | null;
}): string {
  return lines(
    `📊 <b>${esc(a.account)}</b>`,
    `${a.window === 'five' ? '5시간' : '주간'} 한도 ${Math.round(a.pct)}% 사용 (알림 기준 ${a.limitPct}%)`,
    a.resetsAt ? `초기화: ${kstTime(a.resetsAt)}` : null,
    link(`${publicUrl}/`, '대시보드에서 열기'),
  );
}

export function signupText(publicUrl: string, u: { email: string; name: string | null }): string {
  return lines(
    '👤 <b>가입 신청</b>',
    esc(u.name ? `${u.name} (${u.email})` : u.email),
    '관리자 화면에서 승인해 주세요.',
    link(`${publicUrl}/admin`, '관리자 화면 열기'),
  );
}

export const TEST_TEXT = '🔔 <b>c-monitor</b>\n시험 알림입니다. 앞으로 알림이 이 채팅으로 옵니다.';

// ── 버튼 ────────────────────────────────────────────────
// callback_data는 64바이트까지라 telegram_messages의 id(짧은 숫자)만 담는다.
//   p:<id>:a|s|d   승인 허용 / 이 세션 동안 허용 / 거부
//   o:<id>:<i>     첫 질문의 i번째 선택지
//   m:<id>         이 세션 알림 끄기

export const MUTE_LABEL = '🔕 이 세션 알림 끄기';

export function permissionButtons(rowId: string, sessionAllow: boolean): InlineKeyboard {
  return [
    [{ text: '허용', callback_data: `p:${rowId}:a` }, ...(sessionAllow ? [{ text: '이 세션 동안 허용', callback_data: `p:${rowId}:s` }] : [])],
    [{ text: '거부', callback_data: `p:${rowId}:d` }],
  ];
}

export function optionButtons(rowId: string, q: ReplyQuestion): InlineKeyboard {
  return q.options.map((o, i) => [{ text: head(o.label, BUTTON_MAX), callback_data: `o:${rowId}:${i}` }]);
}

export const muteRow = (rowId: string): InlineKeyboard => [[{ text: MUTE_LABEL, callback_data: `m:${rowId}` }]];

/** 버튼을 누른 뒤 원래 메시지 끝에 붙이는 결과 한 줄. */
export const resultLine = (text: string) => `\n\n<b>${esc(text)}</b>`;
