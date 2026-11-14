// 원격 답장 보내기 상태. 카드와 상세 패널이 같은 세션을 함께 보여 줄 수 있어서 대시보드 한 곳에 둔다.
// - 승인·질문에 답하면 그 요청(pending.id)을 잠근다. 서버가 session 갱신으로 pending을 없애면 버튼도 사라진다.
// - 실패하면 잠금을 풀고 까닭을 잠시 보여 준다.
import type { ReplyRequest, ReplyResponse, SessionView } from '@c-monitor/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api/client';

type Entry = {
  /** 답을 보낸(또는 보내는 중인) 승인·질문 id */
  lock?: string;
  /** 보낸 답을 사람이 읽는 말로(예: "허용") */
  label?: string;
  /** 응답을 기다리는 중 */
  busy?: boolean;
  /** 글(type:'message')을 보내는 중 */
  sendingMessage?: boolean;
  error?: string;
};

export type ReplyCtl = {
  /** 이 승인·질문은 이미 답을 보내 잠겼는가 */
  isLocked: (sessionId: string, pendingId: string) => boolean;
  /** 이 승인·질문에 보낸 답(응답을 받은 뒤에만) */
  sentLabel: (sessionId: string, pendingId: string) => string | null;
  sendingMessage: (sessionId: string) => boolean;
  error: (sessionId: string) => string | null;
  /** 보낸다. 성공하면 응답, 실패하면 null(까닭은 error로). */
  send: (session: SessionView, body: ReplyRequest, label?: string) => Promise<ReplyResponse | null>;
};

/** 오류 문구를 보여 두는 시간 */
const ERROR_MS = 6000;

export function useReplies(): ReplyCtl {
  const [map, setMap] = useState<Record<string, Entry>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => () => { for (const t of Object.values(timers.current)) clearTimeout(t); }, []);

  const patch = useCallback((id: string, p: Partial<Entry> | ((e: Entry) => Entry)) => {
    setMap((m) => {
      const cur = m[id] ?? {};
      return { ...m, [id]: typeof p === 'function' ? p(cur) : { ...cur, ...p } };
    });
  }, []);

  const send = useCallback(async (s: SessionView, body: ReplyRequest, label?: string) => {
    const id = s.id;
    const lock = body.type === 'message' ? undefined : body.requestId;
    clearTimeout(timers.current[id]);
    patch(id, (e) => ({
      ...e,
      error: undefined,
      ...(lock ? { lock, label, busy: true } : { sendingMessage: true }),
    }));
    try {
      const res = await api.replyToSession(id, body);
      patch(id, (e) => ({
        ...e,
        busy: lock ? false : e.busy,
        sendingMessage: lock ? e.sendingMessage : false,
      }));
      return res ?? { ok: true, queued: false };
    } catch (err) {
      const text = api.replyErrorText(err);
      patch(id, (e) => ({
        ...e,
        error: text,
        ...(lock ? { lock: undefined, label: undefined, busy: false } : { sendingMessage: false }),
      }));
      timers.current[id] = setTimeout(() => patch(id, { error: undefined }), ERROR_MS);
      return null;
    }
  }, [patch]);

  const isLocked = useCallback((sid: string, pid: string) => map[sid]?.lock === pid, [map]);
  const sentLabel = useCallback(
    (sid: string, pid: string) => (map[sid]?.lock === pid && !map[sid]?.busy ? map[sid]?.label ?? null : null),
    [map],
  );
  const sendingMessage = useCallback((sid: string) => !!map[sid]?.sendingMessage, [map]);
  const error = useCallback((sid: string) => map[sid]?.error ?? null, [map]);

  return { isLocked, sentLabel, sendingMessage, error, send };
}
