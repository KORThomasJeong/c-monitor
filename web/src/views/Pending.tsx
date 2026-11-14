// 승인 대기. 가입 신청은 됐고 관리자 승인을 기다리는 사용자에게 보인다.
// 연결 링크(/connect?code=…) 등으로 들어왔다가 여기로 왔으면 ?next=로 그 주소를 받아 둔다.
// 승인 뒤 그 링크를 다시 열 수 있게 보여 주고, 승인이 확인되면 그리로 돌아간다.
import { useCallback, useEffect, useState } from 'react';
import * as api from '../api/client';
import { ClockIcon } from '../components/Icons';
import { useTheme } from '../lib/prefs';
import { Link, navigate, useLocation } from '../router';
import type { MeResponse } from '@c-monitor/shared';
import { Consent } from './Account';
import { safeNext } from './Login';

/** 승인됐는지 저절로 다시 확인하는 간격 */
const RECHECK_MS = 20_000;

export function Pending() {
  const theme = useTheme();
  const { search } = useLocation();
  const raw = safeNext(search.get('next'));
  const next = raw && !raw.startsWith('/pending') && !raw.startsWith('/login') ? raw : null;
  const [note, setNote] = useState('');
  /** 아직 가입 고지에 동의하지 않았으면 동의 화면을 먼저 보인다(동의해야 관리자에게 신청이 간다). */
  const [needConsent, setNeedConsent] = useState<MeResponse | null>(null);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => api.getMe())
      .then((me) => {
        if (!live || !me?.user) return;
        if (me.user.deleteAt) navigate('/withdrawn', { replace: true });
        else if (!me.user.consentedAt) setNeedConsent(me);
      })
      .catch(() => { /* 화면은 그대로 두고 다음 확인에 맡긴다 */ });
    return () => { live = false; };
  }, []); // 처음 한 번만(승인 여부는 아래 주기적 확인이 본다)

  const check = useCallback(async (quiet: boolean) => {
    if (!quiet) setNote('');
    try {
      const me = await api.getMe();
      if (me.user.status === 'active') navigate(next ?? '/', { replace: true });
      else if (!quiet) setNote('아직 승인되지 않았습니다.');
    } catch {
      if (!quiet) setNote('상태를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
    }
  }, [next]);

  // 승인되면 저절로 넘어간다(연결 코드는 10분 뒤 만료되므로 기다리는 동안 계속 확인).
  useEffect(() => {
    const t = setInterval(() => { void check(true); }, RECHECK_MS);
    return () => clearInterval(t);
  }, [check]);

  const out = async () => {
    try { await api.logout(); } finally {
      navigate(next ? `/login?next=${encodeURIComponent(next)}` : '/login', { replace: true });
    }
  };

  if (needConsent) {
    return (
      <Consent
        me={needConsent}
        onDone={(me) => {
          setNeedConsent(null);
          if (me.user.status === 'active') navigate(next ?? '/', { replace: true });
        }}
      />
    );
  }

  return (
    <div className={`app ${theme.cls}`}>
      <div className="center">
        <div className="auth">
          <div className="auth-head">
            <span className="brand-mark" aria-hidden="true"><ClockIcon size={24} /></span>
            <h1 className="h1" style={{ fontSize: 20 }}>승인을 기다리고 있습니다</h1>
            <p className="sub" style={{ margin: 0 }}>가입 신청을 받았습니다. 관리자가 승인하면 사용할 수 있습니다.</p>
          </div>
          {next && (
            <div className="notice next-link">
              <span>승인을 받은 뒤 아래 링크를 다시 열어 주세요.</span>
              <Link to={next} className="next-url">{next}</Link>
              {next.startsWith('/connect') && <span className="hint">컴퓨터 연결 코드는 10분이 지나면 만료됩니다. 만료됐으면 터미널에서 연결 명령을 다시 실행해 주세요.</span>}
            </div>
          )}
          {note && <p className="hint" role="status" style={{ margin: 0, textAlign: 'center' }}>{note}</p>}
          <div className="btn-row">
            <button type="button" className="btn" onClick={out}>로그아웃</button>
            <button type="button" className="btn primary" onClick={() => void check(false)}>승인 확인</button>
          </div>
        </div>
      </div>
    </div>
  );
}
