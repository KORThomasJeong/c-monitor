// 원격 답장 화면 조각: 승인·질문 답 버튼(카드·상세 공용), 상세 패널 아래 글 입력창.
// 확인 창 없이 바로 보낸다. 누르면 잠그고, 서버가 pending을 없애면 버튼째 사라진다. 실패하면 풀고 까닭을 보인다.
import { MESSAGE_MAX_CHARS, type PendingView, type ReplyQuestion, type ReplyRequest, type SessionView } from '@c-monitor/shared';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { answersOf, isInstantQuestion, type QuestionPick } from '../lib/reply';
import type { ReplyCtl } from '../state/reply';
import { AlertIcon, CheckIcon, SendIcon } from './Icons';

type Behavior = 'allow' | 'allow_session' | 'deny';
const BEHAVIOR_LABEL: Record<Behavior, string> = { allow: '허용', allow_session: '이 세션 동안 허용', deny: '거부' };

/** 카드 안에서 눌러도 카드 선택(상세 열기)이 일어나지 않게 막는다. */
const stop = (e: MouseEvent) => e.stopPropagation();

/** 질문 하나(머리말·질문 글·선택지). */
function Question({
  q, index, pick, instant, compact, locked, withText, onPick, onText,
}: {
  q: ReplyQuestion;
  index: number;
  pick: QuestionPick | undefined;
  instant: boolean;
  compact: boolean;
  locked: boolean;
  /** 질문별 직접 입력칸을 보일지(상세 패널에서 질문이 여러 개일 때) */
  withText: boolean;
  onPick: (label: string) => void;
  onText: (text: string) => void;
}) {
  const picked = pick?.picked ?? [];
  const name = q.header || `질문 ${index + 1}`;
  return (
    <div className="rq" role="group" aria-label={name}>
      {q.header && <span className="rq-head">{q.header}{q.multiSelect && <span className="rq-multi"> · 여러 개 고르기</span>}</span>}
      {!q.header && q.multiSelect && <span className="rq-head"><span className="rq-multi">여러 개 고르기</span></span>}
      <div className="code q">{q.question}</div>
      {q.options.length > 0 && (
        <div className="opts">
          {q.options.map((o) => {
            const on = picked.includes(o.label);
            return (
              <button
                type="button"
                key={o.label}
                className={on ? 'opt live on' : 'opt live'}
                aria-pressed={instant ? undefined : on}
                title={o.description || undefined}
                disabled={locked}
                onClick={() => onPick(o.label)}
              >
                <span className="opt-label">{o.label}</span>
                {!compact && o.description && <span className="opt-desc">{o.description}</span>}
              </button>
            );
          })}
        </div>
      )}
      {withText && (
        <input
          className="input rq-text"
          aria-label={`${name} 직접 입력`}
          placeholder="직접 입력"
          maxLength={MESSAGE_MAX_CHARS}
          value={pick?.text ?? ''}
          disabled={locked}
          onChange={(e) => onText(e.target.value)}
        />
      )}
    </div>
  );
}

type PendingProps = {
  s: SessionView;
  pending: PendingView;
  ctl: ReplyCtl;
  /** 카드 안(좁은 자리) */
  compact?: boolean;
  /** 오류 문구를 이 자리에 보일지(상세 패널은 입력창 쪽에 보인다) */
  showError?: boolean;
};

/** 지금 기다리는 승인·질문과 답 버튼. */
export function PendingReply({ s, pending: p, ctl, compact = false, showError = true }: PendingProps) {
  const hintId = useId();
  const [picks, setPicks] = useState<Record<number, QuestionPick>>({});
  // 다른 요청으로 바뀌면 고른 것을 비운다.
  useEffect(() => { setPicks({}); }, [p.id]);

  const locked = ctl.isLocked(s.id, p.id);
  const sent = ctl.sentLabel(s.id, p.id);
  const error = showError ? ctl.error(s.id) : null;
  const qs = p.kind === 'question' ? p.questions ?? [] : [];
  const instant = isInstantQuestion(qs);
  const withText = !compact && qs.length > 1;

  const permit = (b: Behavior) => {
    const body: ReplyRequest = { type: 'permission', requestId: p.id, behavior: b };
    void ctl.send(s, body, BEHAVIOR_LABEL[b]);
  };
  const answer = (answers: Record<string, string>) => {
    void ctl.send(s, { type: 'answer', requestId: p.id, answers }, Object.values(answers).join(' / '));
  };

  const onPick = (i: number, label: string) => {
    const q = qs[i]!;
    if (instant) { answer({ [q.question]: label }); return; }
    setPicks((m) => {
      const cur = m[i] ?? { picked: [], text: '' };
      const has = cur.picked.includes(label);
      const picked = q.multiSelect
        ? (has ? cur.picked.filter((x) => x !== label) : [...cur.picked, label])
        : (has ? [] : [label]);
      // 단일 선택에서 선택지를 고르면 직접 쓴 글은 비운다(둘 중 하나만 답이 된다).
      return { ...m, [i]: { picked, text: q.multiSelect ? cur.text : '' } };
    });
  };
  const onText = (i: number, text: string) => {
    const q = qs[i]!;
    setPicks((m) => {
      const cur = m[i] ?? { picked: [], text: '' };
      return { ...m, [i]: { picked: q.multiSelect || !text.trim() ? cur.picked : [], text } };
    });
  };
  const ready = !instant && qs.length > 0 ? answersOf(qs, picks) : null;

  const title = p.kind === 'permission' ? `${p.toolName} 실행 승인을 기다립니다` : '질문에 답해 주세요';
  const cls = compact ? 'reply c-reply' : 'reply ask';

  return (
    <div className={cls} role="group" aria-label={`${s.name} 답하기`} onClick={stop}>
      <div className="ask-title">
        <AlertIcon size={16} />
        <span className="reply-title">{title}</span>
        {p.more > 0 && <span className="tag red reply-more">외 {p.more}개 대기</span>}
      </div>

      {p.kind === 'permission' && (
        <>
          {p.summary && <div className="code reply-what" title={p.summary}>{p.summary}</div>}
          <div className="opts">
            <button type="button" className="opt live" disabled={locked} onClick={() => permit('allow')}>허용</button>
            {p.sessionAllow != null && (
              <button type="button" className="opt live" disabled={locked} title={p.sessionAllow} aria-describedby={hintId} onClick={() => permit('allow_session')}>
                이 세션 동안 허용
              </button>
            )}
            <button type="button" className="opt live deny" disabled={locked} onClick={() => permit('deny')}>거부</button>
          </div>
          {p.sessionAllow != null && <p className="reply-hint" id={hintId}>이 세션 동안 허용: {p.sessionAllow}</p>}
        </>
      )}

      {p.kind === 'question' && (
        <>
          {qs.map((q, i) => (
            <Question
              key={`${i}-${q.question}`}
              q={q}
              index={i}
              pick={picks[i]}
              instant={instant}
              compact={compact}
              locked={locked}
              withText={withText}
              onPick={(label) => onPick(i, label)}
              onText={(t) => onText(i, t)}
            />
          ))}
          {!instant && (
            <div className="reply-send">
              <button type="button" className="btn sm primary" disabled={locked || !ready} onClick={() => ready && answer(ready)}>
                <SendIcon size={14} />보내기
              </button>
            </div>
          )}
        </>
      )}

      {locked && !sent && <p className="reply-state" role="status">보내는 중입니다</p>}
      {sent && <p className="sent" role="status"><CheckIcon size={14} />보냈습니다 · {sent}</p>}
      {error && <p className="reply-err" role={compact ? 'status' : 'alert'}>{error}</p>}
      {!compact && !locked && !error && (
        <div className="ask-note"><SendIcon size={14} />누르면 바로 보냅니다. 터미널에서 먼저 답하면 그쪽이 우선합니다.</div>
      )}
    </div>
  );
}

/** 입력창이 하는 일 */
type Mode = 'deny' | 'answer' | 'message';

/** 상세 패널 아래 글 입력창. canReply일 때만 그린다(부르는 쪽에서 거른다). */
export function Composer({ s, ctl }: { s: SessionView; ctl: ReplyCtl }) {
  const id = useId();
  const [text, setText] = useState('');
  const [justQueued, setJustQueued] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  // 서버가 대기 수를 새로 알려 주면 그 값을 따른다.
  useEffect(() => { setJustQueued(false); }, [s.queuedMessages]);

  const p = s.pending;
  const mode: Mode = p?.kind === 'permission' ? 'deny' : p?.kind === 'question' ? 'answer' : 'message';
  const firstQ = p?.kind === 'question' ? p.questions?.[0] : undefined;
  const locked = !!p && ctl.isLocked(s.id, p.id);
  const sending = ctl.sendingMessage(s.id);
  const error = ctl.error(s.id);
  const empty = text.trim().length === 0;
  const disabled = empty || sending || locked || (mode === 'answer' && !firstQ);

  const hint = mode === 'deny'
    ? '보내면 이 승인 요청을 거부하고 글을 전합니다'
    : mode === 'answer'
      ? '이 글을 질문의 답으로 보냅니다'
      : s.status === 'done' ? '다음 지시로 바로 전달됩니다' : '지금 작업이 끝나면 이어서 전달됩니다';
  const button = mode === 'deny' ? '거부하고 글 보내기' : mode === 'answer' ? '답 보내기' : '보내기';

  const submit = async () => {
    if (disabled) return;
    const body = text.trim();
    let req: ReplyRequest;
    let label: string | undefined;
    if (mode === 'deny' && p) { req = { type: 'permission', requestId: p.id, behavior: 'deny', message: body }; label = '거부하고 글 보냄'; }
    else if (mode === 'answer' && p && firstQ) { req = { type: 'answer', requestId: p.id, answers: { [firstQ.question]: body } }; label = body; }
    else req = { type: 'message', text: body };
    const res = await ctl.send(s, req, label);
    if (!res) return;
    setText('');
    if (req.type === 'message' && res.queued) setJustQueued(true);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // 한글 조합 중 Enter는 글자를 확정할 뿐 보내지 않는다.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void submit();
  };

  // 휴대폰에서 키보드가 올라와도 입력창이 보이게 한다.
  const onFocus = () => {
    setTimeout(() => { try { box.current?.scrollIntoView?.({ block: 'nearest' }); } catch { /* 옛 브라우저 */ } }, 300);
  };

  const waiting = Math.max(s.queuedMessages, justQueued ? 1 : 0);
  const count = text.length;

  return (
    <div className="composer">
      <div className="composer-lbl">
        <label htmlFor={id}>클로드에게 보내기</label>
        <span>{hint}</span>
      </div>
      {error && <p className="reply-err" role="alert"><AlertIcon size={14} />{error}</p>}
      <div className="composer-row">
        <textarea
          id={id}
          ref={box}
          value={text}
          maxLength={MESSAGE_MAX_CHARS}
          rows={2}
          enterKeyHint="send"
          placeholder="Enter로 보내고 Shift+Enter로 줄을 바꿉니다"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onFocus={onFocus}
        />
        <button type="button" className="btn primary composer-btn" aria-label={button} disabled={disabled} onClick={() => void submit()}>
          <SendIcon size={16} /><span className="composer-btn-text">{button}</span>
        </button>
      </div>
      {(waiting > 0 || count > MESSAGE_MAX_CHARS * 0.9) && (
        <div className="composer-foot">
          {waiting > 0 && <span role="status">작업이 끝나면 전달됩니다 ({waiting}개 대기)</span>}
          {count > MESSAGE_MAX_CHARS * 0.9 && <span className="composer-count">{count} / {MESSAGE_MAX_CHARS}</span>}
        </div>
      )}
    </div>
  );
}
