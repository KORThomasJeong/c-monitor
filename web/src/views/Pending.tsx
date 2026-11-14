// 승인 대기. 가입 신청은 됐고 관리자 승인을 기다리는 사용자에게 보인다.
import { useState } from 'react';
import * as api from '../api/client';
import { ClockIcon } from '../components/Icons';
import { useTheme } from '../lib/prefs';
import { navigate } from '../router';

export function Pending() {
  const theme = useTheme();
  const [note, setNote] = useState('');

  const check = async () => {
    setNote('');
    try {
      const me = await api.getMe();
      if (me.user.status === 'active') navigate('/', { replace: true });
      else setNote('아직 승인되지 않았습니다.');
    } catch {
      setNote('상태를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
    }
  };
  const out = async () => {
    try { await api.logout(); } finally { navigate('/login', { replace: true }); }
  };

  return (
    <div className={`app ${theme.cls}`}>
      <div className="center">
        <div className="auth">
          <div className="auth-head">
            <span className="brand-mark" aria-hidden="true"><ClockIcon size={24} /></span>
            <h1 className="h1" style={{ fontSize: 20 }}>승인을 기다리고 있습니다</h1>
            <p className="sub" style={{ margin: 0 }}>가입 신청을 받았습니다. 관리자가 승인하면 사용할 수 있습니다.</p>
          </div>
          {note && <p className="hint" role="status" style={{ margin: 0, textAlign: 'center' }}>{note}</p>}
          <div className="btn-row">
            <button type="button" className="btn" onClick={out}>로그아웃</button>
            <button type="button" className="btn primary" onClick={check}>승인 확인</button>
          </div>
        </div>
      </div>
    </div>
  );
}
