// 세션 공유 창: 링크 만들기(만료 1시간/1일/7일/없음), 사람 지정(가입한 사용자 이메일), 목록과 취소.
// 링크 주소는 서버가 만들 때 한 번만 내려 준다(토큰은 해시로만 저장). 창을 닫으면 다시 볼 수 없다.
import type { SessionView, ShareView } from '@c-monitor/shared';
import { useEffect, useId, useRef, useState } from 'react';
import * as api from '../api/client';
import { formatClock } from '../lib/format';
import { CloseIcon, CopyIcon, InfoIcon } from './Icons';

type Expiry = '1h' | '1d' | '7d' | 'never';
const EXPIRY: [Expiry, string][] = [['1h', '1시간'], ['1d', '1일'], ['7d', '7일'], ['never', '없음']];

type Note = { ok: boolean; text: string } | null;

/** 사람 지정 실패 까닭 */
export function shareErrorText(e: unknown): string {
  const code = api.errorCode(e);
  if (code === 'user_not_found') return '가입하지 않은 이메일입니다. 이 서비스에 가입한 사람에게만 공유할 수 있습니다.';
  if (code === 'self') return '자기 자신에게는 공유할 수 없습니다.';
  if (e instanceof api.ApiError && e.status === 400) return '이메일 주소를 확인해 주세요.';
  return '공유하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
}

async function copyText(text: string, input: HTMLInputElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* 아래 방법으로 */ }
  try {
    input?.select();
    return document.execCommand?.('copy') ?? false;
  } catch {
    return false;
  }
}

export function ShareDialog({ s, onClose, now }: { s: SessionView; onClose: () => void; now: number }) {
  const titleId = useId();
  const [shares, setShares] = useState<ShareView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [expiry, setExpiry] = useState<Expiry>('1d');
  const [made, setMade] = useState<ShareView | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<null | 'link' | 'user' | string>(null);
  const [note, setNote] = useState<Note>(null);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    api.getShares(s.id)
      .then((list) => live && setShares(list))
      .catch(() => { if (live) { setShares([]); setLoadFailed(true); } });
    return () => { live = false; };
  }, [s.id]);

  // 열리면 창 안으로 포커스를 옮긴다.
  useEffect(() => { box.current?.querySelector<HTMLElement>('select, input, button')?.focus(); }, []);

  // Esc로 닫는다(포커스가 창 밖으로 빠진 뒤에도).
  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);

  const makeLink = async () => {
    setBusy('link');
    setNote(null);
    setCopied(false);
    try {
      const v = await api.createShare(s.id, { kind: 'link', expiresIn: expiry });
      setMade(v);
      setShares((list) => [v, ...(list ?? []).filter((x) => x.id !== v.id)]);
    } catch {
      setNote({ ok: false, text: '링크를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
    } finally {
      setBusy(null);
    }
  };

  const addUser = async () => {
    const v = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { setNote({ ok: false, text: '이메일 주소를 확인해 주세요.' }); return; }
    setBusy('user');
    setNote(null);
    try {
      const sh = await api.createShare(s.id, { kind: 'user', email: v });
      setShares((list) => [sh, ...(list ?? []).filter((x) => x.id !== sh.id)]);
      setEmail('');
      setNote({ ok: true, text: `${sh.email ?? v}님에게 공유했습니다. 그 사람의 대시보드 "공유받은 세션"에 보입니다.` });
    } catch (e) {
      setNote({ ok: false, text: shareErrorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (sh: ShareView) => {
    setBusy(sh.id);
    setNote(null);
    try {
      await api.deleteShare(sh.id);
      setShares((list) => list?.filter((x) => x.id !== sh.id) ?? null);
      if (made?.id === sh.id) setMade(null);
      setNote({ ok: true, text: '공유를 취소했습니다.' });
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 404) {
        setShares((list) => list?.filter((x) => x.id !== sh.id) ?? null);
      } else {
        setNote({ ok: false, text: '공유를 취소하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
      }
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!made?.url) return;
    const ok = await copyText(made.url, urlRef.current);
    setCopied(ok);
    if (!ok) setNote({ ok: false, text: '복사하지 못했습니다. 주소를 직접 골라 복사해 주세요.' });
  };

  const expText = (sh: ShareView) => (sh.expiresAt ? `${formatClock(sh.expiresAt, now)}까지` : '만료 없음');

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={box}>
        <div className="dialog-head">
          <h2 className="sec-title" id={titleId}>{s.name} 공유</h2>
          <button type="button" className="icon-btn" aria-label="닫기" onClick={onClose}><CloseIcon size={16} /></button>
        </div>
        <div className="dialog-body">
          <section className="share-part" aria-label="링크로 공유">
            <h3 className="share-h">링크로 공유</h3>
            <p className="hint">링크를 가진 사람은 로그인 없이 이 세션의 상태와 대화를 볼 수만 있습니다. 컴퓨터 정보와 다른 세션은 보이지 않습니다.</p>
            <div className="inline">
              <label htmlFor={`${titleId}-exp`} className="hint">만료</label>
              <select id={`${titleId}-exp`} className="input select" value={expiry} onChange={(e) => setExpiry(e.target.value as Expiry)}>
                {EXPIRY.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
              </select>
              <button type="button" className="btn sm primary" onClick={makeLink} disabled={busy !== null}>링크 만들기</button>
            </div>
            {made?.url && (
              <div className="share-made">
                <div className="inline share-url">
                  <input ref={urlRef} className="input mono" readOnly value={made.url} aria-label="만든 공유 링크" onFocus={(e) => e.currentTarget.select()} />
                  <button type="button" className="btn sm" onClick={copy}><CopyIcon size={14} />{copied ? '복사됨' : '복사'}</button>
                </div>
                <p className="notice" role="note"><InfoIcon size={16} /><span>이 주소는 지금 한 번만 보입니다. 창을 닫으면 다시 볼 수 없으니 지금 복사해 두세요.</span></p>
              </div>
            )}
          </section>

          <section className="share-part" aria-label="사람 지정">
            <h3 className="share-h">사람 지정</h3>
            <p className="hint">이 서비스에 가입한 사람의 Gmail 주소를 넣으면 그 사람의 대시보드에 보기 전용으로 나타납니다.</p>
            <div className="inline share-user">
              <input
                className="input"
                type="email"
                aria-label="공유할 사람 이메일"
                placeholder="name@gmail.com"
                value={email}
                maxLength={320}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addUser(); } }}
              />
              <button type="button" className="btn sm primary" onClick={addUser} disabled={busy !== null || email.trim() === ''}>추가</button>
            </div>
          </section>

          {note && <p className={note.ok ? 'save-note ok' : 'save-note bad'} role="status">{note.text}</p>}

          <section className="share-part" aria-label="공유 목록">
            <h3 className="share-h">공유 목록</h3>
            {shares === null && <p className="hint">불러오는 중입니다.</p>}
            {loadFailed && <p className="hint">공유 목록을 불러오지 못했습니다.</p>}
            {shares && shares.length === 0 && !loadFailed && <p className="hint">아직 공유하지 않았습니다.</p>}
            {shares && shares.length > 0 && (
              <ul className="share-list">
                {shares.map((sh) => (
                  <li key={sh.id}>
                    <span className="share-what">
                      <span className={sh.kind === 'link' ? 'tag blue' : 'tag neutral'}>{sh.kind === 'link' ? '링크' : '사람'}</span>
                      <span className="share-name">{sh.kind === 'link' ? expText(sh) : sh.email}</span>
                    </span>
                    <span className="share-meta hint">{formatClock(sh.createdAt, now)}</span>
                    <button type="button" className="link-btn danger" onClick={() => void cancel(sh)} disabled={busy !== null}>취소</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
