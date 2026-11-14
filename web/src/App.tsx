// 주소(location.pathname)에 따라 화면을 고른다.
// /login·/pending·/s/<토큰>(공유 링크) 외에는 먼저 로그인 사용자(/api/me)를 확인한다.
// 확인한 뒤: 탈퇴 중이면 "탈퇴 취소" 화면만, 동의 전이면 동의 화면, 승인 대기면 /pending.
import type { MeResponse } from '@c-monitor/shared';
import { useEffect, useState } from 'react';
import * as api from './api/client';
import { ApiError } from './api/client';
import { useTheme } from './lib/prefs';
import { navigate, useLocation } from './router';
import { Consent, Withdrawn } from './views/Account';
import { AdminUsers } from './views/AdminUsers';
import { ConnectApprove } from './views/ConnectApprove';
import { Dashboard } from './views/Dashboard';
import { Login } from './views/Login';
import { Pending } from './views/Pending';
import { PublicSession } from './views/PublicSession';
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

/** 그린 뒤 주소를 옮긴다(그리는 도중에 옮기지 않는다). */
function Redirect({ to }: { to: string }) {
  useEffect(() => { navigate(to, { replace: true }); }, [to]);
  return <Notice title="불러오는 중입니다" />;
}

/** /s/<토큰> 의 토큰. 깨진 주소면 그대로 쓴다(서버가 404). */
function tokenOf(pathname: string): string {
  const raw = pathname.slice(3).split('/')[0] ?? '';
  try { return decodeURIComponent(raw); } catch { return raw; }
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
        // 연결 링크(/connect?code=…) 등으로 들어왔으면 승인 뒤 돌아갈 수 있게 주소를 넘긴다.
        // 동의 전·탈퇴 중이면 그 화면이 먼저다(동의해야 가입 신청이 관리자에게 간다).
        if (!me.user.deleteAt && me.user.consentedAt && me.user.status === 'pending') {
          navigate(`/pending${api.nextQuery()}`, { replace: true });
        }
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
  if (me.user.deleteAt) {
    return <Withdrawn me={me} onRestored={(next) => { navigate('/', { replace: true }); setState({ me: next }); }} />;
  }
  // 탈퇴 중이 아니면 이 주소에 머물 까닭이 없다.
  if (pathname === '/withdrawn') return <Redirect to="/" />;
  if (!me.user.consentedAt) {
    return (
      <Consent
        me={me}
        onDone={(next) => {
          if (next.user.status === 'pending') navigate(`/pending${api.nextQuery()}`, { replace: true });
          setState({ me: next });
        }}
      />
    );
  }
  if (me.user.status === 'suspended') {
    return <Notice title="사용이 정지된 계정입니다" text="관리자에게 문의해 주세요." />;
  }
  switch (pathname) {
    case '/connect': return <ConnectApprove me={me} code={search.get('code')} />;
    case '/settings': return <Settings me={me} />;
    case '/admin': return <AdminUsers me={me} />;
    // 관리자가 남의 대시보드(?user=)를 보다가 돌아오면 새로 붙는다.
    default: return <Dashboard key={search.get('user') ?? ''} me={me} />;
  }
}

export function App() {
  const { pathname, search } = useLocation();
  if (pathname === '/login') return <Login />;
  if (pathname === '/pending') return <Pending />;
  if (pathname.startsWith('/s/')) return <PublicSession key={pathname} token={tokenOf(pathname)} />;
  // /withdrawn 으로 옮겨지면(403 withdrawn) 로그인 사용자를 새로 확인한다.
  return <Authed key={pathname === '/withdrawn' ? 'withdrawn' : 'app'} pathname={pathname} search={search} />;
}
