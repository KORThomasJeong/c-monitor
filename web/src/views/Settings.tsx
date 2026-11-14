// 설정: 내 컴퓨터, 클로드 계정(별칭·숨기기), 알림(텔레그램), 표시 기준, 보관 기간.
import { REPLY_MIN_PLUGIN, type AccountView, type MachineView, type MeResponse, type SettingsView } from '@c-monitor/shared';
import { useEffect, useState } from 'react';
import * as api from '../api/client';
import { LogoutIcon } from '../components/Icons';
import { Sec, SidePage } from '../components/SidePage';
import { formatAgo } from '../lib/format';
import { pluginSupportsReply } from '../lib/reply';
import { navigate } from '../router';
import { NotifySection } from './Notify';

const NAV: [string, string][] = [
  ['machines', '컴퓨터'], ['accounts', '클로드 계정'], ['notify', '알림'], ['rules', '표시 기준'], ['retention', '보관 기간'],
];

type NumKey = keyof SettingsView;
// 범위는 서버 검증(server/src/query/routes.ts SettingsSchema)과 같게 둔다.
const FIELDS: { key: NumKey; id: string; label: string; unit: string; min: number; max: number }[] = [
  { key: 'lostMinutes', id: 'lost-min', label: '연락 끊김으로 표시', unit: '분 동안 소식이 없을 때', min: 1, max: 1440 },
  { key: 'endHours', id: 'end-hour', label: '종료 카드 유지', unit: '시간 뒤 목록에서 숨깁니다', min: 0, max: 8760 },
  { key: 'keepChatDays', id: 'keep-chat', label: '대화 기록', unit: '일', min: 1, max: 3650 },
  { key: 'keepUsageDays', id: 'keep-usage', label: '사용량 기록', unit: '일', min: 1, max: 3650 },
];
/** 별칭 최대 길이(서버 AccountPatchSchema와 같음). */
const ALIAS_MAX = 60;
type Draft = Record<NumKey, string>;
const toDraft = (s: SettingsView): Draft => ({
  lostMinutes: String(s.lostMinutes), endHours: String(s.endHours),
  keepChatDays: String(s.keepChatDays), keepUsageDays: String(s.keepUsageDays),
});

export function Settings({ me }: { me: MeResponse }) {
  const [machines, setMachines] = useState<MachineView[] | null>(null);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [base, setBase] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [alias, setAlias] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const now = Date.now();

  const resetAccounts = (list: AccountView[]) => {
    setAlias(Object.fromEntries(list.map((a) => [a.email, a.alias ?? ''])));
    setHidden(Object.fromEntries(list.map((a) => [a.email, a.hidden])));
  };

  useEffect(() => {
    let live = true;
    Promise.all([api.getDashboard(), api.getSettings()])
      .then(([dash, s]) => {
        if (!live) return;
        setMachines(dash.machines);
        setAccounts(dash.accounts);
        resetAccounts(dash.accounts);
        setBase(s);
        setDraft(toDraft(s));
      })
      .catch(() => live && setStatus({ ok: false, text: '설정을 불러오지 못했습니다.' }));
    return () => { live = false; };
  }, []);

  const revoke = async (id: string) => {
    if (confirming !== id) { setConfirming(id); return; }
    setConfirming(null);
    try {
      await api.revokeMachine(id);
      setMachines((list) => list?.filter((m) => m.id !== id) ?? null);
    } catch {
      setStatus({ ok: false, text: '연결을 해제하지 못했습니다.' });
    }
  };

  /** 원격 답장 스위치는 저장 단추 없이 바로 바꾼다. 실패하면 되돌린다. */
  const toggleReply = async (m: MachineView, on: boolean) => {
    const set = (v: boolean) => setMachines((list) => list?.map((x) => (x.id === m.id ? { ...x, remoteReply: v } : x)) ?? null);
    set(on);
    setStatus(null);
    try {
      const res = await api.patchMachine(m.id, { remoteReply: on });
      if (res && typeof res === 'object' && 'remoteReply' in res && typeof res.remoteReply === 'boolean') set(res.remoteReply);
    } catch {
      set(!on);
      setStatus({ ok: false, text: `${m.name}의 원격 답장을 바꾸지 못했습니다.` });
    }
  };

  const revert = () => {
    if (base) setDraft(toDraft(base));
    resetAccounts(accounts);
    setStatus(null);
  };

  const save = async () => {
    if (!draft) return;
    const next = {} as SettingsView;
    for (const f of FIELDS) {
      const n = Number(draft[f.key]);
      if (draft[f.key].trim() === '' || !Number.isInteger(n) || n < f.min || n > f.max) {
        setStatus({ ok: false, text: `${f.label}에는 ${f.min}부터 ${f.max}까지의 정수를 넣어 주세요.` });
        return;
      }
      next[f.key] = n;
    }
    setSaving(true);
    setStatus(null);
    try {
      const patches = accounts.flatMap((a) => {
        const p: { alias?: string | null; hidden?: boolean } = {};
        const al = (alias[a.email] ?? '').trim();
        if (al !== (a.alias ?? '')) p.alias = al || null;
        if ((hidden[a.email] ?? a.hidden) !== a.hidden) p.hidden = hidden[a.email];
        return Object.keys(p).length ? [api.patchAccount(a.email, p).then(() => ({ ...a, ...p }))] : [];
      });
      const [, updated] = await Promise.all([api.putSettings(next), Promise.all(patches)]);
      const byEmail = new Map(updated.map((a) => [a.email, a]));
      const merged = accounts.map((a) => byEmail.get(a.email) ?? a);
      setAccounts(merged);
      resetAccounts(merged);
      setBase(next);
      setDraft(toDraft(next));
      setStatus({ ok: true, text: '저장했습니다.' });
    } catch {
      setStatus({ ok: false, text: '저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
    } finally {
      setSaving(false);
    }
  };

  const logout = async () => {
    try { await api.logout(); } finally { navigate('/login', { replace: true }); }
  };

  const numField = (f: (typeof FIELDS)[number]) => (
    <div className="field" key={f.key}>
      <label htmlFor={f.id}>{f.label}</label>
      <div className="inline">
        <input
          id={f.id}
          className="input num"
          type="number"
          inputMode="numeric"
          min={f.min}
          max={f.max}
          value={draft?.[f.key] ?? ''}
          disabled={!draft}
          onChange={(e) => setDraft((d) => (d ? { ...d, [f.key]: e.target.value } : d))}
        />
        <span>{f.unit}</span>
      </div>
    </div>
  );

  return (
    <SidePage
      me={me}
      page="settings"
      title="설정"
      desc="연결한 컴퓨터와 클로드 계정, 텔레그램 알림, 카드 표시 기준과 보관 기간을 정합니다."
      nav={NAV}
      menuLabel="설정 메뉴"
      actions={
        <button type="button" className="icon-btn" aria-label="로그아웃" title="로그아웃" onClick={logout}><LogoutIcon /></button>
      }
    >
      <Sec
        id="machines"
        title="내 컴퓨터"
        desc="원격 답장을 켜면 웹에서 그 컴퓨터의 세션에 승인·답·글을 보낼 수 있습니다(바로 적용). 연결을 해제하면 연결 키가 바로 막히고, 다시 쓰려면 연결 명령을 새로 실행해야 합니다."
        aside={machines && <span className="tag blue"><span className="dot" />{machines.length}대 연결됨</span>}
      >
        <div className="tbl-box">
          <table className="tbl">
            <thead><tr><th>컴퓨터</th><th>운영체제</th><th>플러그인</th><th>마지막 전송</th><th>상태</th><th>원격 답장</th><th className="r">관리</th></tr></thead>
            <tbody>
              {machines === null && <tr><td colSpan={7} className="muted">불러오는 중입니다.</td></tr>}
              {machines?.length === 0 && <tr><td colSpan={7} className="muted">연결한 컴퓨터가 없습니다.</td></tr>}
              {machines?.map((m) => (
                <tr key={m.id}>
                  <td><b style={{ fontWeight: 500 }}>{m.name}</b></td>
                  <td className="muted">{m.os || '—'}</td>
                  <td className="muted">{m.pluginVersion || '—'}</td>
                  <td className="muted">{formatAgo(m.lastSeenAt, now)}</td>
                  <td><span className={m.online ? 'tag green' : 'tag neutral'}><span className="dot" />{m.online ? '연결됨' : '오프라인'}</span></td>
                  <td>
                    <span className="sw-cell">
                      <input
                        className="sw"
                        type="checkbox"
                        role="switch"
                        aria-label={`${m.name} 원격 답장`}
                        aria-describedby={pluginSupportsReply(m) ? undefined : `old-${m.id}`}
                        checked={m.remoteReply}
                        onChange={(e) => void toggleReply(m, e.target.checked)}
                      />
                      {!pluginSupportsReply(m) && (
                        <span className="tag amber" id={`old-${m.id}`} title={`플러그인 ${REPLY_MIN_PLUGIN} 이상에서 원격 답장을 쓸 수 있습니다`}>
                          플러그인 업데이트 필요
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="r">
                    <button type="button" className="link-btn danger" onClick={() => revoke(m.id)} onBlur={() => setConfirming((c) => (c === m.id ? null : c))}>
                      {confirming === m.id ? '해제 확인' : '연결 해제'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Sec>

      <Sec id="accounts" title="클로드 계정" desc="별칭은 카드와 한도 표시에 쓰입니다. 숨긴 계정은 대시보드 한도 카드에서 빠집니다.">
        <div className="tbl-box">
          <table className="tbl">
            <thead><tr><th>클로드 계정</th><th>별칭</th><th>마지막 갱신</th><th className="r">숨기기</th></tr></thead>
            <tbody>
              {accounts.length === 0 && <tr><td colSpan={4} className="muted">아직 기록된 클로드 계정이 없습니다.</td></tr>}
              {accounts.map((a) => (
                <tr key={a.email}>
                  <td>{a.email}</td>
                  <td>
                    <input
                      className="input alias-input"
                      aria-label={`${a.email} 별칭`}
                      value={alias[a.email] ?? ''}
                      maxLength={ALIAS_MAX}
                      placeholder="예: 회사"
                      onChange={(e) => setAlias((m) => ({ ...m, [a.email]: e.target.value }))}
                    />
                  </td>
                  <td className="muted">{formatAgo(a.at, now)}</td>
                  <td className="r">
                    <input
                      className="sw"
                      type="checkbox"
                      role="switch"
                      aria-label={`${a.email} 숨기기`}
                      checked={hidden[a.email] ?? a.hidden}
                      onChange={(e) => setHidden((m) => ({ ...m, [a.email]: e.target.checked }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Sec>

      <NotifySection isAdmin={me.user.role === 'admin'} />

      <Sec id="rules" title="표시 기준" desc="카드 색이 바뀌는 시간을 정합니다." body>
        <div className="form-grid">{FIELDS.slice(0, 2).map(numField)}</div>
      </Sec>

      <Sec id="retention" title="보관 기간" desc="기간이 지난 기록은 매일 새벽 4시에 지웁니다." body>
        <div className="form-grid">{FIELDS.slice(2).map(numField)}</div>
      </Sec>

      <div className="save-bar">
        {status && <span className={status.ok ? 'save-note ok' : 'save-note bad'} role="status">{status.text}</span>}
        <button type="button" className="btn" onClick={revert} disabled={saving}>되돌리기</button>
        <button type="button" className="btn primary" onClick={save} disabled={saving || !draft}>저장</button>
      </div>
    </SidePage>
  );
}
