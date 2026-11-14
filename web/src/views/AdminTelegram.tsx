// 관리 > 알림: 모든 사용자가 함께 쓰는 텔레그램 봇 토큰. 계약은 shared/src/contract.ts "관리자: 텔레그램 봇" 절.
// 토큰은 저장만 하고 다시 보여 주지 않는다(서버가 끝 4자리만 내려준다). 입력칸도 저장하면 바로 비운다.
import type { AdminTelegramView } from '@c-monitor/shared';
import { useEffect, useState } from 'react';
import * as api from '../api/client';
import { ExternalIcon } from '../components/Icons';
import { Sec } from '../components/SidePage';
import { formatClock } from '../lib/format';

/** 계약 AdminTelegramPutSchema.token 과 같은 꼴(숫자:영숫자 30자 이상) */
export const TOKEN_RE = /^[0-9]{5,}:[A-Za-z0-9_-]{30,}$/;
const BOTFATHER = 'https://t.me/BotFather';

const POLLING: Record<AdminTelegramView['polling'], [string, string]> = {
  ok: ['정상', 'tag green'], error: ['오류', 'tag red'], off: ['꺼짐', 'tag neutral'],
};

type Note = { ok: boolean; text: string } | null;

export function AdminTelegram() {
  const [view, setView] = useState<AdminTelegramView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<null | 'save' | 'off'>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const now = Date.now();

  useEffect(() => {
    let live = true;
    api.getAdminTelegram()
      .then((v) => live && setView(v))
      .catch(() => live && setLoadFailed(true));
    return () => { live = false; };
  }, []);

  const save = async () => {
    const t = token.trim();
    if (!TOKEN_RE.test(t)) {
      setNote({ ok: false, text: '토큰 꼴이 맞지 않습니다. "숫자:영문·숫자" 꼴 전체를 붙여 넣어 주세요.' });
      return;
    }
    setBusy('save');
    setNote(null);
    try {
      const v = await api.putAdminTelegram(t);
      setView(v);
      setToken('');
      setEditing(false);
      setNote({ ok: true, text: v.botUsername ? `@${v.botUsername} 봇을 저장했습니다.` : '봇 토큰을 저장했습니다.' });
    } catch (e) {
      const code = api.errorCode(e);
      setNote({
        ok: false,
        text: code === 'invalid_token'
          ? '텔레그램이 이 토큰을 받아 주지 않습니다. 토큰을 다시 확인해 주세요.'
          : '토큰을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
      });
    } finally {
      setBusy(null);
    }
  };

  const turnOff = async () => {
    if (!confirmOff) { setConfirmOff(true); return; }
    setConfirmOff(false);
    setBusy('off');
    setNote(null);
    try {
      setView(await api.deleteAdminTelegram());
      setEditing(false);
      setNote({ ok: true, text: '봇을 껐습니다. 사용자 연결 정보는 남아 있어 토큰을 다시 넣으면 이어서 쓸 수 있습니다.' });
    } catch {
      setNote({ ok: false, text: '봇을 끄지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
    } finally {
      setBusy(null);
    }
  };

  const configured = !!view?.configured;
  const showForm = !!view && (!configured || editing);
  const [pollText, pollCls] = POLLING[view?.polling ?? 'off'];

  const aside = view && (configured
    ? <span className={pollCls}><span className="dot" />{pollText}</span>
    : <span className="tag neutral"><span className="dot" />설정 안 됨</span>);

  return (
    <Sec
      id="notify"
      title="알림"
      desc="모든 사용자가 함께 쓰는 텔레그램 봇입니다. 사용자는 설정 › 알림에서 각자 연결합니다."
      aside={aside}
      body
    >
      {loadFailed && <p className="hint">봇 설정을 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.</p>}
      {!view && !loadFailed && <p className="hint">불러오는 중입니다.</p>}

      {view && configured && (
        <div className="dl">
          <div className="dl-row"><span className="k">봇</span><span className="v">{view.botUsername ? `@${view.botUsername}` : '—'}</span></div>
          <div className="dl-row"><span className="k">토큰</span><span className="v mono">{view.tokenHint ? `••••${view.tokenHint}` : '—'}</span></div>
          <div className="dl-row">
            <span className="k">받기 상태</span>
            <span className="v"><span className={pollCls}><span className="dot" />{pollText}</span></span>
          </div>
          {view.lastError && (
            <div className="dl-row"><span className="k">마지막 오류</span><span className="v bad-text" title={view.lastError}>{view.lastError}</span></div>
          )}
          <div className="dl-row"><span className="k">연결한 사용자</span><span className="v">{view.linkedUsers}명</span></div>
          <div className="dl-row"><span className="k">바꾼 시각</span><span className="v">{formatClock(view.updatedAt, now)}</span></div>
        </div>
      )}

      {showForm && (
        <div className="form-grid">
          <div className="field">
            <label htmlFor="tg-token">텔레그램 봇 토큰</label>
            <input
              id="tg-token"
              className="input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="123456789:AA…"
              value={token}
              aria-describedby="tg-token-hint"
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }}
            />
            <span className="hint" id="tg-token-hint">@BotFather에서 만든 봇의 토큰입니다. 저장하면 다시 보이지 않습니다.</span>
          </div>
          <div className="field">
            <span className="lbl">봇 만드는 법</span>
            <ol className="tg-steps">
              <li>텔레그램에서 <a href={BOTFATHER} target="_blank" rel="noopener noreferrer">@BotFather<ExternalIcon size={12} /></a>를 엽니다.</li>
              <li><code>/newbot</code>을 보내고 봇 이름과 사용자 이름(끝이 bot)을 정합니다.</li>
              <li>받은 토큰을 토큰 칸에 붙여 넣고 저장합니다.</li>
            </ol>
          </div>
        </div>
      )}

      {note && <p className={note.ok ? 'save-note ok' : 'save-note bad'} role="status">{note.text}</p>}

      {view && (
        <div className="tg-actions end">
          {showForm ? (
            <>
              {configured && <button type="button" className="btn" onClick={() => { setEditing(false); setToken(''); setNote(null); }} disabled={busy !== null}>취소</button>}
              <button type="button" className="btn primary" onClick={save} disabled={busy !== null || token.trim() === ''}>저장</button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => { setEditing(true); setNote(null); }} disabled={busy !== null}>토큰 바꾸기</button>
              <button
                type="button"
                className="btn danger"
                onClick={turnOff}
                onBlur={() => setConfirmOff(false)}
                disabled={busy !== null}
              >
                {confirmOff ? '끄기 확인' : '봇 끄기'}
              </button>
            </>
          )}
        </div>
      )}
    </Sec>
  );
}
