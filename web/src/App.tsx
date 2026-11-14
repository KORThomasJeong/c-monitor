// 주소(location.pathname)에 따라 화면을 고른다.
// /login·/pending 외에는 먼저 로그인 사용자(/api/me)를 확인한다.
import type { MeResponse } from '@c-monitor/shared';
import { useEffect, useState } from 'react';
import * as api from './api/client';
import { ApiError } from './api/client';
import { useTheme } from './lib/prefs';
import { navigate, useLocation } from './router';
import { AdminUsers } from './views/AdminUsers';
import { ConnectApprove } from './views/ConnectApprove';
import { Dashboard } from './views/Dashboard';
import { Login } from './views/Login';
import { Pending } from './views/Pending';
import { Settings } from './views/Settings';

function Notice({ title, text, retry }: { title: string; text?: string; retry?: () => void }) {
  const theme = useTheme();
  return (
    <div className={`app ${theme.cls}`}>
      <div className="center">
        <div className="auth" role="status">
          <div className="auth-head">
            <h1 className="h1" style={{ fontSize: 20 }}>{title}</h1>
            {text && <p className="sub" style={{ margin: 0 }}>{text}</p>}
          </div>
          {retry && <button type="button" className="btn primary block" onClick={retry}>다시 시도</button>}
        </div>
      </div>
    </div>
  );
}

type MeState = { me: MeResponse } | { error: 'auth' | 'network' } | null;

function Authed({ pathname, search }: { pathname: string; search: URLSearchParams }) {
  const [state, setState] = useState<MeState>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    api.getMe()
      .then((me) => {
        if (!live) return;
        if (me.user.status === 'pending') navigate('/pending', { replace: true });
        setState({ me });
      })
      // 401·403(pending)은 client가 이미 화면을 옮겼다.
      .catch((e) => live && setState({ error: e instanceof ApiError && e.status < 500 ? 'auth' : 'network' }));
    return () => { live = false; };
  }, [attempt]);

  if (state === null) return <Notice title="불러오는 중입니다" />;
  if ('error' in state) {
    return state.error === 'network'
      ? <Notice title="서버에 연결하지 못했습니다" text="잠시 뒤 다시 시도해 주세요." retry={() => { setState(null); setAttempt((n) => n + 1); }} />
      : <Notice title="로그인이 필요합니다" text="로그인 화면으로 이동합니다." />;
  }
  const { me } = state;
  if (me.user.status === 'suspended') {
    return <Notice title="사용이 정지된 계정입니다" text="관리자에게 문의해 주세요." />;
  }
  switch (pathname) {
    case '/connect': return <ConnectApprove me={me} code={search.get('code')} />;
    case '/settings': return <Settings me={me} />;
    case '/admin': return <AdminUsers me={me} />;
    default: return <Dashboard me={me} />;
  }
}

export function App() {
  const { pathname, search } = useLocation();
  if (pathname === '/login') return <Login />;
  if (pathname === '/pending') return <Pending />;
  return <Authed pathname={pathname} search={search} />;
}
