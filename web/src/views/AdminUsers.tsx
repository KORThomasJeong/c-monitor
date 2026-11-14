// 관리자: 승인 대기 · 사용자(추가·권한·용량 한도·정지·탈퇴 복구·즉시 삭제·대시보드 보기) · 컴퓨터 · 알림(텔레그램 봇) · 저장 용량.
// role==='admin'만. 계약은 shared/src/contract.ts "관리자" 절.
import { DEFAULT_QUOTA_MB, type AdminUserView, type MeResponse, type UserView } from '@c-monitor/shared';
import { useEffect, useState } from 'react';
import * as api from '../api/client';
import { EyeIcon } from '../components/Icons';
import { Sec, SidePage } from '../components/SidePage';
import { formatAgo, formatBytes, formatDateTime, formatQuota } from '../lib/format';
import { useTheme } from '../lib/prefs';
import { roParticle } from '../lib/view';
import { Link } from '../router';
import { AdminMachines, AdminStorage } from './AdminMore';
import { AdminTelegram } from './AdminTelegram';

const NAV: [string, string][] = [
  ['pending', '승인 대기'], ['users', '사용자'], ['machines', '컴퓨터'], ['notify', '알림'], ['storage', '저장 용량'],
];

const STATE: Record<UserView['status'], [string, string]> = {
  active: ['사용 중', 'tag green'], pending: ['승인 대기', 'tag amber'], suspended: ['정지됨', 'tag neutral'],
};

/** 예전 서버가 새 필드를 주지 않아도 화면이 깨지지 않게 채운다. */
function normalize(u: Partial<AdminUserView> & UserView): AdminUserView {
  return {
    createdAt: '', lastLoginAt: null, quotaMb: DEFAULT_QUOTA_MB, bytes: 0, machines: 0, invited: false,
    ...u,
    consentedAt: u.consentedAt ?? null,
    deleteAt: u.deleteAt ?? null,
  };
}

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

/** 사용자 추가 실패 까닭 */
function addErrorText(e: unknown): string {
  const code = api.errorCode(e);
  if (code === 'exists' || code === 'user_exists' || (e instanceof api.ApiError && e.status === 409)) return '이미 있는 사용자입니다.';
  if (e instanceof api.ApiError && e.status === 400) return '이메일 주소를 확인해 주세요.';
  return '사용자를 추가하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
}

/** 용량 한도 칸(MB, 0 = 무제한). Enter나 칸을 떠나면 저장한다. */
function QuotaInput({ u, onSave, disabled }: { u: AdminUserView; onSave: (mb: number) => Promise<boolean>; disabled: boolean }) {
  const [v, setV] = useState(String(u.quotaMb));
  useEffect(() => { setV(String(u.quotaMb)); }, [u.quotaMb]);
  const commit = async () => {
    const n = Number(v);
    if (v.trim() === '' || !Number.isInteger(n) || n < 0 || n > 1_000_000) { setV(String(u.quotaMb)); return; }
    if (n === u.quotaMb) return;
    if (!(await onSave(n))) setV(String(u.quotaMb));
  };
  return (
    <span className="inline quota-cell">
      <input
        className="input num quota-input"
        type="number"
        inputMode="numeric"
        min={0}
        max={1_000_000}
        aria-label={`${u.email} 용량 한도(MB, 0은 무제한)`}
        value={v}
        disabled={disabled}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void commit(); } }}
      />
      <span className="hint">MB</span>
    </span>
  );
}

export function AdminUsers({ me }: { me: MeResponse }) {
  const isAdmin = me.user.role === 'admin';
  const [users, setUsers] = useState<AdminUserView[] | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'user'>('user');
  const now = Date.now();

  useEffect(() => {
    if (!isAdmin) return;
    let live = true;
    api.getAdminUsers()
      .then((list) => live && setUsers(list.map(normalize)))
      .catch(() => live && setError('사용자 목록을 불러오지 못했습니다.'));
    return () => { live = false; };
  }, [isAdmin]);

  if (!isAdmin) return <NotAdmin />;

  const put = (u: AdminUserView) => setUsers((list) => list?.map((x) => (x.id === u.id ? normalize({ ...x, ...u }) : x)) ?? null);
  const say = (good: string, bad = '') => { setOk(good); setError(bad); };

  const act = async (u: AdminUserView, kind: 'approve' | 'suspend') => {
    setBusy(u.id);
    say('');
    try {
      await (kind === 'approve' ? api.approveUser(u.id) : api.suspendUser(u.id));
      put({ ...u, status: kind === 'approve' ? 'active' : 'suspended' });
    } catch {
      say('', kind === 'approve' ? '승인하지 못했습니다.' : '정지하지 못했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    const email = newEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { say('', '이메일 주소를 확인해 주세요.'); return; }
    setBusy('add');
    say('');
    try {
      const u = normalize(await api.createAdminUser(email, newRole));
      setUsers((list) => [...(list ?? []).filter((x) => x.id !== u.id), u]);
      setNewEmail('');
      say(`${u.email}을 추가했습니다. 첫 로그인 때 승인 없이 바로 쓸 수 있습니다(가입 고지 동의는 받습니다).`);
    } catch (e) {
      say('', addErrorText(e));
    } finally {
      setBusy(null);
    }
  };

  const patch = async (u: AdminUserView, p: { role?: 'admin' | 'user'; quotaMb?: number }) => {
    setBusy(u.id);
    say('');
    try {
      const res = await api.patchAdminUser(u.id, p);
      put(res && typeof res === 'object' && 'id' in res ? res : { ...u, ...p });
      const q = formatQuota(p.quotaMb ?? u.quotaMb);
      say(p.role ? `${u.email}의 권한을 바꿨습니다.` : `${u.email}의 용량 한도를 ${q}${roParticle(q)} 바꿨습니다.`);
      return true;
    } catch (e) {
      say('', api.errorCode(e) === 'self' ? '자기 자신의 관리자 권한은 내릴 수 없습니다.' : '바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const restore = async (u: AdminUserView) => {
    setBusy(u.id);
    say('');
    try {
      const res = await api.restoreAdminUser(u.id);
      put(res && typeof res === 'object' && 'id' in res ? res : { ...u, deleteAt: null });
      say(`${u.email}의 탈퇴를 취소했습니다.`);
    } catch {
      say('', '복구하지 못했습니다.');
    } finally {
      setBusy(null);
    }
  };

  /** 즉시 완전 삭제. 한 번 더 눌러 확인한다. */
  const remove = async (u: AdminUserView) => {
    if (confirm !== u.id) { setConfirm(u.id); return; }
    setConfirm(null);
    setBusy(u.id);
    say('');
    try {
      await api.deleteAdminUser(u.id);
      setUsers((list) => list?.filter((x) => x.id !== u.id) ?? null);
      say(`${u.email}을 지웠습니다.`);
    } catch {
      say('', '지우지 못했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const pending = users?.filter((u) => u.status === 'pending' && !u.invited) ?? [];
  const others = users?.filter((u) => u.status !== 'pending' || u.invited) ?? [];
  const loading = users === null && !error;

  const addForm = (
    <div className="inline add-user">
      <label htmlFor="new-user" className="hint">Gmail 주소</label>
      <input
        id="new-user"
        className="input"
        style={{ width: 220 }}
        type="email"
        placeholder="name@gmail.com"
        value={newEmail}
        onChange={(e) => setNewEmail(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }}
      />
      <select className="input select" aria-label="추가할 사용자 권한" value={newRole} onChange={(e) => setNewRole(e.target.value as 'admin' | 'user')}>
        <option value="user">사용자</option>
        <option value="admin">관리자</option>
      </select>
      <button type="button" className="btn sm primary" onClick={add} disabled={busy !== null || newEmail.trim() === ''}>사용자 추가</button>
    </div>
  );

  return (
    <SidePage
      me={me}
      page="admin"
      tag="관리자"
      title="관리"
      desc="가입 신청을 승인하고 사용자·컴퓨터·알림 봇·저장 용량을 관리합니다. 관리자는 서비스 운영을 위해 모든 사용자의 대화를 볼 수 있습니다."
      nav={NAV}
      menuLabel="관리 메뉴"
    >
      {error && <p className="save-note bad" role="alert" style={{ margin: 0 }}>{error}</p>}
      {ok && <p className="save-note ok" role="status" style={{ margin: 0 }}>{ok}</p>}

      <Sec
        id="pending"
        title="승인 대기"
        desc="Gmail로 가입을 신청한 사람입니다. 승인하면 바로 대시보드를 쓸 수 있습니다."
        aside={pending.length > 0 && <span className="tag amber"><span className="dot" />{pending.length}명 기다림</span>}
      >
        <div className="tbl-box">
          <table className="tbl">
            <thead><tr><th>Gmail 계정</th><th>이름</th><th>신청</th><th className="r">관리</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={4} className="muted">불러오는 중입니다.</td></tr>}
              {users && pending.length === 0 && <tr><td colSpan={4} className="muted">기다리는 신청이 없습니다.</td></tr>}
              {pending.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td className="muted">{u.name ?? '—'}</td>
                  <td className="muted">{u.createdAt ? formatAgo(u.createdAt, now) : '—'}</td>
                  <td className="r">
                    <button type="button" className="btn sm primary" disabled={busy === u.id} onClick={() => act(u, 'approve')}>승인</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Sec>

      <Sec
        id="users"
        title="사용자"
        desc="미리 추가한 Gmail은 첫 로그인 때 승인 없이 씁니다. 정지하면 바로 로그인과 전송이 막힙니다. 용량 한도 0은 무제한입니다."
        aside={addForm}
      >
        <div className="tbl-box">
          <table className="tbl users-tbl">
            <thead>
              <tr>
                <th>Gmail 계정</th><th>권한</th><th>상태</th><th>사용량</th><th>한도</th><th>컴퓨터</th><th>마지막 로그인</th><th className="r">관리</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={8} className="muted">불러오는 중입니다.</td></tr>}
              {others.map((u) => {
                const self = u.id === me.user.id;
                const [stText, stCls] = u.deleteAt
                  ? ['탈퇴 예정', 'tag red']
                  : u.invited ? ['초대됨', 'tag blue'] : STATE[u.status];
                const over = u.quotaMb > 0 && u.bytes > u.quotaMb * 1024 * 1024;
                return (
                  <tr key={u.id}>
                    <td>
                      <span className="u-email">{u.email}</span>
                      {u.name && <div className="muted">{u.name}</div>}
                    </td>
                    <td>
                      <select
                        className="input select role-select"
                        aria-label={`${u.email} 권한`}
                        value={u.role}
                        disabled={self || busy === u.id || !!u.deleteAt}
                        title={self ? '자기 자신의 관리자 권한은 내릴 수 없습니다' : undefined}
                        onChange={(e) => void patch(u, { role: e.target.value as 'admin' | 'user' })}
                      >
                        <option value="admin">관리자</option>
                        <option value="user">사용자</option>
                      </select>
                    </td>
                    <td>
                      <span className={stCls}><span className="dot" />{stText}</span>
                      {u.deleteAt && <div className="muted">{formatDateTime(u.deleteAt)} 삭제</div>}
                    </td>
                    <td className={over ? 'bad-text' : 'muted'}>{formatBytes(u.bytes)}</td>
                    <td><QuotaInput u={u} disabled={busy === u.id || !!u.deleteAt} onSave={(mb) => patch(u, { quotaMb: mb })} /></td>
                    <td className="muted">{u.machines}대</td>
                    <td className="muted">{u.invited ? '로그인 전' : formatAgo(u.lastLoginAt, now)}</td>
                    <td className="r">
                      <span className="row-actions">
                        {!u.invited && !u.deleteAt && !self && (
                          <Link className="link-btn" to={`/?user=${encodeURIComponent(u.id)}`} aria-label={`${u.email} 대시보드 보기`}>
                            <EyeIcon size={14} />대시보드 보기
                          </Link>
                        )}
                        {self ? (
                          <span className="muted">본인</span>
                        ) : u.deleteAt ? (
                          <>
                            <button type="button" className="link-btn" disabled={busy === u.id} onClick={() => restore(u)}>복구</button>
                            <button type="button" className="link-btn danger" disabled={busy === u.id} onClick={() => remove(u)}
                              onBlur={() => setConfirm((c) => (c === u.id ? null : c))}>
                              {confirm === u.id ? '삭제 확인' : '즉시 삭제'}
                            </button>
                          </>
                        ) : u.invited ? (
                          <button type="button" className="link-btn danger" disabled={busy === u.id} onClick={() => remove(u)}
                            onBlur={() => setConfirm((c) => (c === u.id ? null : c))}>
                            {confirm === u.id ? '삭제 확인' : '초대 취소'}
                          </button>
                        ) : u.status === 'suspended' ? (
                          <button type="button" className="link-btn" disabled={busy === u.id} onClick={() => act(u, 'approve')}>다시 허용</button>
                        ) : (
                          <button type="button" className="link-btn danger" disabled={busy === u.id} onClick={() => act(u, 'suspend')}>정지</button>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Sec>

      <AdminMachines />
      <AdminTelegram />
      <AdminStorage />
    </SidePage>
  );
}
