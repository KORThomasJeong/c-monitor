// 관리 › 컴퓨터(모든 사용자의 컴퓨터, 원격 답장 스위치, 연결 해제) · 관리 › 저장 용량(전체·대화·사용량·기타, 디스크, 사용자별).
import { REPLY_MIN_PLUGIN, type AdminMachineView, type AdminStorageView } from '@c-monitor/shared';
import { useEffect, useState } from 'react';
import * as api from '../api/client';
import { Sec } from '../components/SidePage';
import { formatAgo, formatBytes, formatQuota } from '../lib/format';
import { pluginSupportsReply } from '../lib/reply';
import { domainOf } from '../lib/view';

export function AdminMachines() {
  const [list, setList] = useState<AdminMachineView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const now = Date.now();

  useEffect(() => {
    let live = true;
    api.getAdminMachines()
      .then((l) => live && setList(l))
      .catch(() => live && setFailed(true));
    return () => { live = false; };
  }, []);

  const set = (id: string, p: Partial<AdminMachineView>) => setList((l) => l?.map((m) => (m.id === id ? { ...m, ...p } : m)) ?? null);

  const toggle = async (m: AdminMachineView, on: boolean) => {
    set(m.id, { remoteReply: on });
    setNote(null);
    try {
      const res = await api.patchAdminMachine(m.id, { remoteReply: on });
      if (res && typeof res === 'object' && typeof res.remoteReply === 'boolean') set(m.id, { remoteReply: res.remoteReply });
    } catch {
      set(m.id, { remoteReply: !on });
      setNote({ ok: false, text: `${m.name}의 원격 답장을 바꾸지 못했습니다.` });
    }
  };

  const revoke = async (m: AdminMachineView) => {
    if (confirm !== m.id) { setConfirm(m.id); return; }
    setConfirm(null);
    setNote(null);
    try {
      await api.deleteAdminMachine(m.id);
      setList((l) => l?.filter((x) => x.id !== m.id) ?? null);
      setNote({ ok: true, text: `${m.name}(${m.ownerEmail})의 연결을 해제했습니다.` });
    } catch {
      setNote({ ok: false, text: '연결을 해제하지 못했습니다.' });
    }
  };

  return (
    <Sec
      id="machines"
      title="컴퓨터"
      desc="모든 사용자가 연결한 컴퓨터입니다. 해제하면 그 컴퓨터의 연결 키가 바로 막히고, 다시 쓰려면 연결 명령을 새로 실행해야 합니다. 원격 답장을 끄면 웹에서 그 컴퓨터로 답을 보낼 수 없습니다."
      aside={list && <span className="tag blue"><span className="dot" />{list.length}대 연결됨</span>}
    >
      {note && <p className={note.ok ? 'save-note ok sec-note' : 'save-note bad sec-note'} role="status">{note.text}</p>}
      <div className="tbl-box">
        <table className="tbl">
          <thead>
            <tr><th>컴퓨터</th><th>소유자</th><th>운영체제</th><th>클로드 계정</th><th>플러그인</th><th>마지막 전송</th><th>상태</th><th>원격 답장</th><th className="r">관리</th></tr>
          </thead>
          <tbody>
            {list === null && !failed && <tr><td colSpan={9} className="muted">불러오는 중입니다.</td></tr>}
            {failed && <tr><td colSpan={9} className="muted">컴퓨터 목록을 불러오지 못했습니다.</td></tr>}
            {list?.length === 0 && <tr><td colSpan={9} className="muted">연결된 컴퓨터가 없습니다.</td></tr>}
            {list?.map((m) => (
              <tr key={m.id}>
                <td><b style={{ fontWeight: 500 }}>{m.name}</b></td>
                <td className="muted">{m.ownerEmail}</td>
                <td className="muted">{m.os || '—'}</td>
                <td>{m.account ? <span className="chip sk" title={m.account}>{domainOf(m.account)}</span> : <span className="muted">—</span>}</td>
                <td className="muted">{m.pluginVersion || '—'}</td>
                <td className="muted">{formatAgo(m.lastSeenAt, now)}</td>
                <td><span className={m.online ? 'tag green' : 'tag neutral'}><span className="dot" />{m.online ? '연결됨' : '오프라인'}</span></td>
                <td>
                  <span className="sw-cell">
                    <input
                      className="sw"
                      type="checkbox"
                      role="switch"
                      aria-label={`${m.name}(${m.ownerEmail}) 원격 답장`}
                      checked={m.remoteReply}
                      onChange={(e) => void toggle(m, e.target.checked)}
                    />
                    {!pluginSupportsReply(m) && (
                      <span className="tag amber" title={`플러그인 ${REPLY_MIN_PLUGIN} 이상에서 원격 답장을 쓸 수 있습니다`}>업데이트 필요</span>
                    )}
                  </span>
                </td>
                <td className="r">
                  <button type="button" className="link-btn danger" onClick={() => revoke(m)} onBlur={() => setConfirm((c) => (c === m.id ? null : c))}>
                    {confirm === m.id ? '해제 확인' : '연결 해제'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Sec>
  );
}

const pct = (part: number, total: number) => (total > 0 ? Math.max(0, Math.min(100, (part / total) * 100)) : 0);

export function AdminStorage() {
  const [v, setV] = useState<AdminStorageView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    api.getAdminStorage()
      .then((s) => live && setV(s))
      .catch(() => live && setFailed(true));
    return () => { live = false; };
  }, []);

  const parts: [string, number, string][] = v
    ? [['대화', v.chatBytes, 'var(--vivid)'], ['사용량', v.usageBytes, 'var(--accent)'], ['기타', v.otherBytes, 'var(--dis)']]
    : [];
  const users = v ? v.users.slice().sort((a, b) => b.bytes - a.bytes) : [];

  return (
    <Sec id="storage" title="저장 용량" desc="서버에 저장된 기록의 크기입니다. 사용자별 한도는 사용자 표에서 바꿉니다(0은 무제한)." body>
      {!v && !failed && <p className="hint">불러오는 중입니다.</p>}
      {failed && <p className="hint">저장 용량을 불러오지 못했습니다.</p>}
      {v && (
        <>
          <div className="store">
            <div className="inline" style={{ justifyContent: 'space-between' }}>
              <span className="lbl" style={{ fontWeight: 500 }}>전체 {formatBytes(v.totalBytes)}</span>
              <span className="hint">디스크 남은 공간 {v.diskFreeBytes == null ? '알 수 없음' : formatBytes(v.diskFreeBytes)}</span>
            </div>
            <div className="store-bar" role="img" aria-label={parts.map(([k, b]) => `${k} ${formatBytes(b)}`).join(', ')}>
              {parts.map(([k, b, c]) => <span key={k} style={{ width: `${pct(b, v.totalBytes)}%`, background: c }} />)}
            </div>
            <div className="legend">
              {parts.map(([k, b, c]) => <span key={k}><i style={{ background: c }} />{k} {formatBytes(b)}</span>)}
            </div>
          </div>
          <div className="tbl-box">
            <table className="tbl" aria-label="사용자별 저장 용량">
              <thead><tr><th>사용자</th><th>사용량</th><th>한도</th><th>쓴 비율</th></tr></thead>
              <tbody>
                {users.length === 0 && <tr><td colSpan={4} className="muted">사용자가 없습니다.</td></tr>}
                {users.map((u) => {
                  const p = u.quotaMb > 0 ? pct(u.bytes, u.quotaMb * 1024 * 1024) : null;
                  return (
                    <tr key={u.id}>
                      <td>{u.email}</td>
                      <td className="muted">{formatBytes(u.bytes)}</td>
                      <td className="muted">{formatQuota(u.quotaMb)}</td>
                      <td>
                        {p == null ? <span className="muted">한도 없음</span> : (
                          <span className="inline use-cell">
                            <span className="bar use-bar"><span className={`bar-fill ${p >= 95 ? 'crit' : p >= 80 ? 'warn' : ''}`} style={{ width: `${p}%`, display: 'block' }} /></span>
                            <span className="muted">{Math.round(p)}%</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Sec>
  );
}
