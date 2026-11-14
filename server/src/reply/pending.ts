// 원격 답장의 순수 계산: 버전 비교, 답할 수 있는지, 카드에 보일 요청 한 줄.
import { REPLY_MIN_PLUGIN, type PendingView, type ReplyQuestion, type SessionStatus } from '@c-monitor/shared';
import { head } from '../util';

const SUMMARY_MAX = 300;
const SUMMARY_KEYS = ['command', 'file_path', 'pattern', 'description', 'url'] as const;

/** '0.10.1' → [0, 10, 1]. 앞쪽의 숫자 마디만 읽는다('0.2.0-beta' → [0, 2, 0]). 숫자로 시작하지 않으면 null. */
function versionParts(v: string): number[] | null {
  const m = /^\s*v?(\d+(?:\.\d+)*)/.exec(v);
  return m ? m[1]!.split('.').map(Number) : null;
}

/** 버전을 숫자 마디끼리 견준다('0.10.0' ≥ '0.2.0'). 읽을 수 없는 버전은 낮은 것으로 본다. */
export function versionAtLeast(version: string, min: string): boolean {
  const a = versionParts(version);
  const b = versionParts(min);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

/** 그 컴퓨터가 원격 답장을 받을 수 있는가(스위치 켜짐, 폐기 안 됨, 플러그인 버전 충족). */
export function machineCanReply(m: { remoteReply: boolean; revoked: boolean; pluginVersion: string }): boolean {
  return m.remoteReply && !m.revoked && versionAtLeast(m.pluginVersion, REPLY_MIN_PLUGIN);
}

/** 종료·끊김 세션에는 답할 수 없다. */
export const statusCanReply = (status: SessionStatus): boolean => status !== 'end' && status !== 'lost';

/** 무엇을 하려는지 한 줄: 도구 입력의 명령·경로 등에서 처음 있는 것, 없으면 질문 글. */
export function summaryOf(toolInput: unknown, questions: ReplyQuestion[] | null): string {
  const input = (toolInput && typeof toolInput === 'object' ? toolInput : {}) as Record<string, unknown>;
  const picked = SUMMARY_KEYS.map((k) => input[k]).find((v) => typeof v === 'string' && v.length > 0);
  return head(picked ?? questions?.[0]?.question ?? '', SUMMARY_MAX);
}

export type PendingRow = {
  id: string; session_id: string; kind: 'permission' | 'question'; tool_name: string;
  tool_input: unknown; questions: ReplyQuestion[] | null; session_allow: string | null; created_at: Date;
};

export function toPendingView(r: PendingRow, more: number): PendingView {
  const view: PendingView = {
    id: r.id,
    kind: r.kind,
    toolName: r.tool_name,
    summary: summaryOf(r.tool_input, r.questions),
    sessionAllow: r.session_allow,
    at: r.created_at.toISOString(),
    more,
  };
  if (r.questions) view.questions = r.questions;
  return view;
}
