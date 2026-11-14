// 로그인(가입 신청 겸). 목업 Login.dc.html 구조 그대로, 가입 고지 문구를 더했다.
import { GoogleLogo, InfoIcon, LockIcon, PulseIcon } from '../components/Icons';
import { useTheme } from '../lib/prefs';
import { useLocation } from '../router';

/** 같은 사이트 안 경로만 돌아갈 곳으로 받는다(//evil.com 같은 주소 차단). */
export const safeNext = (v: string | null) => (v && v.startsWith('/') && !v.startsWith('//') ? v : null);

export function Login() {
  const theme = useTheme();
  const { search } = useLocation();
  const next = safeNext(search.get('next'));
  const href = next ? `/auth/google?next=${encodeURIComponent(next)}` : '/auth/google';
  return (
    <div className={`app ${theme.cls}`}>
      <div className="center">
        <div className="auth">
          <div className="auth-head">
            <span className="brand-mark" aria-hidden="true"><PulseIcon size={24} /></span>
            <h1 className="h1">C-Monitor</h1>
            <p className="sub" style={{ margin: 0 }}>로그인하면 모든 컴퓨터의 클로드코드 세션 현황을 한곳에서 볼 수 있습니다.</p>
          </div>
          <a className="gbtn" href={href}>
            <GoogleLogo />
            Gmail 계정으로 로그인
          </a>
          <div className="notice">
            <InfoIcon size={16} />
            <span>가입을 신청하면 관리자가 승인한 뒤 사용할 수 있습니다. 관리자는 서비스 운영을 위해 저장된 대화를 볼 수 있습니다.</span>
          </div>
          <div className="notice">
            <LockIcon size={16} />
            <span>Gmail 계정으로만 로그인합니다. 클로드 계정으로는 로그인하지 않습니다.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
