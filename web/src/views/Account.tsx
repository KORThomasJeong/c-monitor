// 계정: 가입 고지·동의 화면, 탈퇴 취소 화면, 설정 › 계정(내 사용량·한도, 탈퇴).
import { WITHDRAW_DAYS, type MeResponse, type StorageMe } from '@c-monitor/shared';
import { useEffect, useState } from 'react';
import * as api from '../api/client';
import { ClockIcon, InfoIcon, LockIcon, PulseIcon } from '../components/Icons';
import { Sec } from '../components/SidePage';
import { formatBytes, formatClock, formatDateTime, formatQuota } from '../lib/format';
import { useTheme } from '../lib/prefs';
import { navigate } from '../router';

async function logoutTo(path = '/login') {
  try { await api.logout(); } catch { /* 그래도 로그인 화면으로 */ } finally { navigate(path, { replace: true }); }
}

/** 첫 로그인(동의 전): 관리자 열람 고지와 비밀 가림 설명, 동의 체크. 동의해야 쓰거나 가입 신청이 관리자에게 간다. */
export function Consent({ me, onDone }: { me: MeResponse; onDone: (me: MeResponse) => void }) {
  const theme = useTheme();
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!agree || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.consent();
      onDone(res?.user ? res : { ...me, user: { ...me.user, consentedAt: new Date().toISOString() } });
    } catch {
      setError('동의를 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
      setBusy(false);
    }
  };

  return (
    <div className={`app ${theme.cls}`}>
      <div className="center">
        <div className="auth consent">
          <div className="auth-head">
            <span className="brand-mark" aria-hidden="true"><PulseIcon size={24} /></span>
            <h1 className="h1" style={{ fontSize: 20 }}>사용 전에 확인해 주세요</h1>
            <p className="sub" style={{ margin: 0 }}>{me.user.email} 계정으로 C-Monitor를 시작합니다.</p>
          </div>
          <div className="notice">
            <InfoIcon size={16} />
            <span><b>관리자는 서비스 운영을 위해 모든 대화를 볼 수 있습니다.</b> 연결한 컴퓨터에서 보낸 세션 상태와 대화 기록은 이 서버에 저장됩니다.</span>
          </div>
          <div className="notice">
            <LockIcon size={16} />
            <span>API 키·비밀번호·토큰처럼 보이는 값은 컴퓨터에서 보내기 전에 가려서(키 N개 가려짐) 저장합니다. 가린 값은 서버에 남지 않아 관리자도 볼 수 없습니다.</span>
          </div>
          <div className="notice">
            <ClockIcon size={16} />
            <span>언제든 설정 › 계정에서 탈퇴할 수 있습니다. 탈퇴하면 {WITHDRAW_DAYS}일 뒤 모든 기록이 지워집니다.</span>
          </div>
          <label className="check">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>위 내용을 확인했고 동의합니다.</span>
          </label>
          {error && <p className="save-note bad" role="alert" style={{ margin: 0 }}>{error}</p>}
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => void logoutTo()}>로그아웃</button>
            <button type="button" className="btn primary" disabled={!agree || busy} onClick={submit}>동의하고 계속</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 탈퇴 신청 뒤(deleteAt): 이 화면만 보인다. 삭제 예정일 전이면 취소할 수 있다. */
export function Withdrawn({ me, onRestored }: { me: MeResponse; onRestored: (me: MeResponse) => void }) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const at = me.user.deleteAt;

  const restore = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.restoreMe();
      onRestored(res?.user ? res : { ...me, user: { ...me.user, deleteAt: null } });
    } catch {
      setError('탈퇴를 취소하지 못했습니다. 삭제 예정일이 지났거나 잠시 문제가 있습니다.');
      setBusy(false);
    }
  };

  return (
    <div className={`app ${theme.cls}`}>
      <div className="center">
        <div className="auth">
          <div className="auth-head">
            <span className="brand-mark danger-mark" aria-hidden="true"><ClockIcon size={24} /></span>
            <h1 className="h1" style={{ fontSize: 20 }}>탈퇴를 신청한 계정입니다</h1>
            <p className="sub" style={{ margin: 0 }}>{me.user.email}</p>
          </div>
          <div className="dl">
            <div className="dl-row"><span className="k">삭제 예정</span><span className="v">{formatDateTime(at)}</span></div>
          </div>
          <p className="hint" style={{ margin: 0 }}>
            지금은 로그인과 컴퓨터 전송이 모두 막혀 있습니다. 삭제 예정일이 지나면 대화·사용량·연결한 컴퓨터·공유가 모두 지워지고 되돌릴 수 없습니다.
            탈퇴를 취소하면 연결한 컴퓨터도 그대로 다시 쓸 수 있습니다.
          </p>
          {error && <p className="save-note bad" role="alert" style={{ margin: 0 }}>{error}</p>}
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => void logoutTo()}>로그아웃</button>
            <button type="button" className="btn primary" disabled={busy} onClick={restore}>탈퇴 취소</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 탈퇴 확인 입력 */
export const WITHDRAW_WORD = '탈퇴';

/** 설정 › 계정: 내 정보, 저장 용량(사용량/한도), 탈퇴. */
export function AccountSection({ me }: { me: MeResponse }) {
  const [storage, setStorage] = useState<StorageMe | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const now = Date.now();

  useEffect(() => {
    let live = true;
    api.getMyStorage()
      .then((s) => live && setStorage(s))
      .catch(() => live && setStorageFailed(true));
    return () => { live = false; };
  }, []);

  const withdraw = async () => {
    if (word.trim() !== WITHDRAW_WORD || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.withdraw();
      // 이제 /api/me 외에는 막힌다. 탈퇴 취소 화면으로 간다.
      navigate('/withdrawn', { replace: true });
    } catch {
      setError('탈퇴하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
      setBusy(false);
    }
  };

  const unlimited = !!storage && storage.quotaMb <= 0;
  const pct = storage && !unlimited ? Math.min(100, (storage.bytes / (storage.quotaMb * 1024 * 1024)) * 100) : 0;
  const lvl = pct >= 95 ? 'crit' : pct >= 80 ? 'warn' : '';

  return (
    <Sec id="account" title="계정" desc="로그인한 Gmail 계정과 저장 용량, 탈퇴입니다." body>
      <div className="dl">
        <div className="dl-row"><span className="k">Gmail 계정</span><span className="v">{me.user.email}</span></div>
        <div className="dl-row"><span className="k">권한</span><span className="v">{me.user.role === 'admin' ? '관리자' : '사용자'}</span></div>
        {me.user.consentedAt && (
          <div className="dl-row"><span className="k">가입 고지 동의</span><span className="v">{formatClock(me.user.consentedAt, now)}</span></div>
        )}
      </div>

      <div className="store" aria-label="저장 용량">
        <div className="inline" style={{ justifyContent: 'space-between' }}>
          <span className="lbl" style={{ fontWeight: 500 }}>저장 용량</span>
          <span className="hint">
            {storage
              ? unlimited ? `${formatBytes(storage.bytes)} 사용 · 한도 없음` : `${formatBytes(storage.bytes)} / ${formatQuota(storage.quotaMb)} 사용`
              : storageFailed ? '불러오지 못했습니다' : '불러오는 중입니다'}
          </span>
        </div>
        {storage && !unlimited && (
          <div className="bar" role="meter" aria-label="내 저장 용량" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
            <div className={`bar-fill ${lvl}`} style={{ width: `${pct}%` }} />
          </div>
        )}
        <span className="hint">한도를 넘으면 매일 정리 때 오래된 대화부터 지웁니다(최근 24시간 대화는 지우지 않습니다). 한도는 관리자가 정합니다.</span>
        {storage?.trimmedAt && (
          <p className="notice warn-notice" role="note">
            <InfoIcon size={16} />
            <span>저장 용량 한도를 넘어 {formatClock(storage.trimmedAt, now)}에 오래된 대화를 지웠습니다.</span>
          </p>
        )}
      </div>

      <div className="withdraw">
        <div className="sw-text">
          <span className="lbl" style={{ fontWeight: 500 }}>탈퇴</span>
          <span className="hint">
            탈퇴하면 바로 로그인과 컴퓨터 전송이 막히고, 공유 링크도 더는 열리지 않습니다. {WITHDRAW_DAYS}일 뒤 모든 기록이 완전히 지워지며, 그 전에 다시 로그인하면 취소할 수 있습니다.
          </span>
        </div>
        {!open ? (
          <button type="button" className="btn danger" onClick={() => setOpen(true)}>탈퇴</button>
        ) : (
          <div className="withdraw-confirm">
            <label htmlFor="withdraw-word" className="hint">확인하려면 <b>{WITHDRAW_WORD}</b>를 입력해 주세요</label>
            <div className="inline">
              <input
                id="withdraw-word"
                className="input"
                style={{ width: 160 }}
                value={word}
                autoComplete="off"
                onChange={(e) => setWord(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void withdraw(); } }}
              />
              <button type="button" className="btn" onClick={() => { setOpen(false); setWord(''); setError(''); }} disabled={busy}>취소</button>
              <button type="button" className="btn danger" onClick={withdraw} disabled={busy || word.trim() !== WITHDRAW_WORD}>탈퇴 신청</button>
            </div>
          </div>
        )}
        {error && <p className="save-note bad" role="alert">{error}</p>}
      </div>
    </Sec>
  );
}
