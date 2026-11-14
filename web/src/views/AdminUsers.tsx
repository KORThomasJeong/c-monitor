// 관리자: 가입 승인 대기 목록과 사용자 목록(정지·다시 허용). role==='admin'만.
import type { MeResponse, UserView } from '@c-monitor/shared';
import { useEffect, useState } from 'react';
import * as api from '../api/client';
import { Sec, SidePage } from '../components/SidePage';
import { useTheme } from '../lib/prefs';
import { Link } from '../router';

const NAV: [string, string][] = [['pending', '승인 대기'], ['users', '사용자']];

const ROLE: Record<UserView['role'], [string, string]> = { admin: ['관리자', 'tag blue'], user: ['사용자', 'tag neutral'] };
const STATE: Record<UserView['status'], [string, string]> = {
  active: ['사용 중', 'tag green'], pending: ['승인 대기', 'tag amber'], suspended: ['정지됨', 'tag neutral'],
};

function NotAdmin() {
  const theme = useTheme();
  return (
    <div className={`app ${theme.cls}`}>
      <div className="center">
        <div className="auth">
          <div className="auth-head">
            <h1 className="h1" style={{ fontSize: 20 }}>들어갈 수 없습니다</h1>
            <p className="sub" style={{ margin: 0 }}>관리자만 볼 수 있는 화면입니다.</p>
          </div>
          <Link className="btn primary block" to="/">대시보드 열기</Link>
        </div>
      </div>
    </div>
  );
}

export function AdminUsers({ me }: { me: MeResponse }) {
  const isAdmin = me.user.role === 'admin';
  const [users, setUsers] = useState<UserView[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let live = true;
    api.getAdminUsers()
      .then((list) => live && setUsers(list))
      .catch(() => live && setError('사용자 목록을 불러오지 못했습니다.'));
    return () => { live = false; };
  }, [isAdmin]);

  if (!isAdmin) return <NotAdmin />;

  const act = async (u: UserView, kind: 'approve' | 'suspend') => {
    setBusy(u.id);
    setError('');
    try {
      await (kind === 'approve' ? api.approveUser(u.id) : api.suspendUser(u.id));
      const status: UserView['status'] = kind === 'approve' ? 'active' : 'suspended';
      setUsers((list) => list?.map((x) => (x.id === u.id ? { ...x, status } : x)) ?? null);
    } catch {
      setError(kind === 'approve' ? '승인하지 못했습니다.' : '정지하지 못했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const pending = users?.filter((u) => u.status === 'pending') ?? [];
  const others = users?.filter((u) => u.status !== 'pending') ?? [];
  const loading = users === null && !error;

  return (
    <SidePage
      me={me}
      page="admin"
      tag="관리자"
      title="관리"
      desc="가입 신청을 승인하고 사용자를 관리합니다. 관리자는 서비스 운영을 위해 모든 사용자의 대화를 볼 수 있습니다."
      nav={NAV}
      menuLabel="관리 메뉴"
    >
      {error && <p className="save-note bad" role="alert" style={{ margin: 0 }}>{error}</p>}

      <Sec
        id="pending"
        title="승인 대기"
        desc="Gmail로 가입을 신청한 사람입니다. 승인하면 바로 대시보드를 쓸 수 있습니다."
        aside={pending.length > 0 && <span className="tag amber"><span className="dot" />{pending.length}명 기다림</span>}
      >
        <div className="tbl-box">
          <table className="tbl">
            <thead><tr><th>Gmail 계정</th><th>이름</th><th className="r">관리</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={3} className="muted">불러오는 중입니다.</td></tr>}
              {users && pending.length === 0 && <tr><td colSpan={3} className="muted">기다리는 신청이 없습니다.</td></tr>}
              {pending.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td className="muted">{u.name ?? '—'}</td>
                  <td className="r">
                    <button type="button" className="btn sm primary" disabled={busy === u.id} onClick={() => act(u, 'approve')}>승인</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Sec>

      <Sec id="users" title="사용자" desc="정지하면 그 사용자는 바로 로그인과 전송이 막힙니다.">
        <div className="tbl-box">
          <table className="tbl">
            <thead><tr><th>Gmail 계정</th><th>이름</th><th>권한</th><th>상태</th><th className="r">관리</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={5} className="muted">불러오는 중입니다.</td></tr>}
              {others.map((u) => {
                const [roleText, roleCls] = ROLE[u.role];
                const [stText, stCls] = STATE[u.status];
                const self = u.id === me.user.id;
                return (
                  <tr key={u.id}>
                    <td>{u.email}</td>
                    <td className="muted">{u.name ?? '—'}</td>
                    <td><span className={roleCls}><span className="dot" />{roleText}</span></td>
                    <td><span className={stCls}><span className="dot" />{stText}</span></td>
                    <td className="r">
                      {self ? (
                        <span className="muted">본인</span>
                      ) : u.status === 'suspended' ? (
                        <button type="button" className="link-btn" disabled={busy === u.id} onClick={() => act(u, 'approve')}>다시 허용</button>
                      ) : (
                        <button type="button" className="link-btn danger" disabled={busy === u.id} onClick={() => act(u, 'suspend')}>정지</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Sec>
    </SidePage>
  );
}
