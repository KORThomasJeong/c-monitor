// 모든 화면 위쪽 헤더. 목업 Main/Admin의 .hdr 구조 그대로.
import type { MeResponse } from '@c-monitor/shared';
import type { ReactNode } from 'react';
import { Link } from '../router';
import { BackIcon, MoonIcon, PulseIcon, SlidersIcon, SunIcon, UsersIcon } from './Icons';

type Props = {
  me: MeResponse | null;
  dark: boolean;
  onToggleTheme: () => void;
  /** 대시보드: 실시간 연결 표시. undefined면 숨김 */
  connected?: boolean;
  /** 브랜드 옆 태그(관리자·설정 화면) */
  tag?: string;
  /** 가운데(간단히 보기의 한도 알약) */
  mid?: ReactNode;
  /** 테마 버튼 앞에 놓을 버튼들 */
  actions?: ReactNode;
  /** 지금 화면. 대시보드면 설정·관리자 링크, 아니면 대시보드로 돌아가는 링크 */
  page: 'dashboard' | 'settings' | 'admin';
};

export function Header({ me, dark, onToggleTheme, connected, tag, mid, actions, page }: Props) {
  const email = me?.user.email ?? '';
  const isAdmin = me?.user.role === 'admin';
  const pending = me?.pendingCount ?? 0;
  return (
    <header className="hdr">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true"><PulseIcon /></span>
        <span className="brand-name">C-Monitor</span>
        {tag && <span className="tag neutral">{tag}</span>}
        {connected !== undefined && (
          <span className={connected ? 'live' : 'live off'} role="status">
            <span className="live-dot" />
            <span className="live-text">{connected ? '실시간 연결됨' : '다시 연결 중'}</span>
          </span>
        )}
      </div>
      {mid}
      <div className="hdr-actions">
        {actions}
        <button type="button" className="icon-btn" aria-label="테마 바꾸기" onClick={onToggleTheme}>
          {dark ? <SunIcon /> : <MoonIcon />}
        </button>
        {page === 'dashboard' ? (
          <>
            <Link className="btn btn-admin" to="/settings" aria-label="설정">
              <SlidersIcon /><span className="btn-text">설정</span>
            </Link>
            {isAdmin && (
              <Link className="btn btn-admin" to="/admin" aria-label={pending ? `관리자 · 승인 대기 ${pending}명` : '관리자'}>
                <UsersIcon /><span className="btn-text">관리자</span>
                {pending > 0 && <span className="badge">{pending}</span>}
              </Link>
            )}
          </>
        ) : (
          <Link className="btn btn-admin" to="/" aria-label="대시보드로">
            <BackIcon /><span className="btn-text">대시보드</span>
          </Link>
        )}
        {email && <span className="avatar" title={`${email} 로그인 중`}>{email.charAt(0).toUpperCase()}</span>}
      </div>
    </header>
  );
}
