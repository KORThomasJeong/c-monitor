// 원격 답장 화면에 쓰는 순수 함수들.
import { REPLY_MIN_PLUGIN, type MachineView, type ReplyQuestion, type SessionView } from '@c-monitor/shared';

/** "0.2.0" 같은 점 버전을 숫자로 비교한다. 뒤에 붙은 "-beta" 등은 무시한다. 읽을 수 없으면 false. */
export function versionAtLeast(v: string | null | undefined, min: string): boolean {
  if (!v) return false;
  const parse = (x: string) => x.trim().replace(/^v/i, '').split(/[-+]/)[0]!.split('.').map((n) => Number(n));
  const a = parse(v);
  const b = parse(min);
  if (a.some((n) => !Number.isFinite(n))) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** 이 컴퓨터의 플러그인이 원격 답장을 지원하는가 */
export const pluginSupportsReply = (m: Pick<MachineView, 'pluginVersion'> | null | undefined) =>
  !!m && versionAtLeast(m.pluginVersion, REPLY_MIN_PLUGIN);

/** 종료·연락 끊김 세션에는 입력창을 아예 보이지 않는다. */
export const isClosed = (s: Pick<SessionView, 'status'>) => s.status === 'end' || s.status === 'lost';

/**
 * 웹에서 답할 수 없는 까닭(입력창 자리에 보일 한 줄). 답할 수 있거나 종료·끊김 세션이면 null.
 * 서버가 주는 canReply가 기준이고, 까닭은 화면이 가진 정보로 짐작한다.
 */
export function replyBlockReason(s: SessionView, m: MachineView | null): string | null {
  if (s.canReply || isClosed(s)) return null;
  if (s.sharedBy) return '공유받은 세션에는 웹에서 답할 수 없습니다.';
  if (m && !m.remoteReply) return '이 컴퓨터는 원격 답장이 꺼져 있습니다. 설정의 내 컴퓨터에서 켤 수 있습니다.';
  if (m && !pluginSupportsReply(m)) return `웹에서 답하려면 이 컴퓨터의 플러그인을 ${REPLY_MIN_PLUGIN} 이상으로 업데이트해 주세요.`;
  return '이 세션에는 지금 웹에서 답할 수 없습니다.';
}

/** 원격 제어 주소는 공식 화면(https://claude.ai/code/…)만 링크로 쓴다. */
export function safeRemoteUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return /^https:\/\/claude\.ai\/code\/[A-Za-z0-9_-]+$/.test(url) ? url : null;
}

/** 질문 하나의 답: 고른 것들과 직접 쓴 글. */
export type QuestionPick = { picked: string[]; text: string };

/**
 * 질문 하나의 답 글. 단일 선택은 직접 쓴 글이 있으면 그것이 답이고, 다중 선택은 고른 것 뒤에 이어 붙인다(", ").
 * 답이 없으면 빈 글.
 */
export function answerOf(q: ReplyQuestion, p: QuestionPick | undefined): string {
  const text = (p?.text ?? '').trim();
  const picked = p?.picked ?? [];
  if (q.multiSelect) return [...picked, text].filter(Boolean).join(', ');
  return text || picked[0] || '';
}

/** 모든 질문에 답했으면 질문 글 → 답, 하나라도 비었으면 null. */
export function answersOf(qs: ReplyQuestion[], picks: Record<number, QuestionPick>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (let i = 0; i < qs.length; i++) {
    const a = answerOf(qs[i]!, picks[i]);
    if (!a) return null;
    out[qs[i]!.question] = a;
  }
  return out;
}

/** 질문 하나이고 단일 선택이면 선택지를 누르는 즉시 보낸다. */
export const isInstantQuestion = (qs: ReplyQuestion[] | undefined) => !!qs && qs.length === 1 && !qs[0]!.multiSelect;
