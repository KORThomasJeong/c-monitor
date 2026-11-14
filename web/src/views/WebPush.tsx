// 설정 › 알림 › 웹 알림: 이 브라우저에서 받기·해제·시험 알림, 이 계정에서 받는 브라우저 목록.
// 그리고 웹 알림 소리(브라우저마다 켜기·끄기).
import { useEffect, useState } from 'react';
import * as api from '../api/client';
import { InfoIcon } from '../components/Icons';
import { formatClock } from '../lib/format';
import { currentEndpoint, notificationPermission, pushSupport, subscribeThisBrowser, unsubscribeThisBrowser } from '../lib/push';
import { isSoundOn, playChime, setSoundOn, unlockSound } from '../lib/sound';

type Note = { ok: boolean; text: string } | null;

type Props = {
  /** 이 계정에 구독된 브라우저(null = 불러오는 중) */
  subs: api.PushSubscriptionInfo[] | null;
  failed: boolean;
  onSubs: (subs: api.PushSubscriptionInfo[]) => void;
};

export function WebPushBlock({ subs, failed, onSubs }: Props) {
  const support = pushSupport();
  const [mine, setMine] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [perm, setPerm] = useState(() => notificationPermission());
  const now = Date.now();

  useEffect(() => {
    let live = true;
    currentEndpoint().then((ep) => live && setMine(ep)).catch(() => {});
    return () => { live = false; };
  }, []);

  const here = !!mine && !!subs?.some((x) => x.endpoint === mine);

  const refresh = async () => {
    try { onSubs(await api.getPushSubscriptions()); } catch { /* 목록은 다음에 */ }
  };

  const subscribe = async () => {
    setBusy('sub');
    setNote(null);
    const res = await subscribeThisBrowser();
    setPerm(notificationPermission());
    if (res.ok) {
      setMine(res.endpoint);
      await refresh();
      setNote({ ok: true, text: '이 브라우저에서 웹 알림을 받습니다. 시험 알림으로 확인해 보세요.' });
    } else if (res.reason === 'denied') {
      setNote({ ok: false, text: '브라우저가 알림을 막았습니다. 주소창 옆 사이트 설정에서 알림을 허용한 뒤 다시 눌러 주세요.' });
    } else {
      setNote({ ok: false, text: '웹 알림을 켜지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
    }
    setBusy(null);
  };

  const remove = async (endpoint: string) => {
    setBusy(endpoint);
    setNote(null);
    try {
      await api.pushUnsubscribe(endpoint);
      if (endpoint === mine) { await unsubscribeThisBrowser(); setMine(null); }
      onSubs((subs ?? []).filter((x) => x.endpoint !== endpoint));
      setNote({ ok: true, text: endpoint === mine ? '이 브라우저의 웹 알림을 해제했습니다.' : '그 브라우저의 웹 알림을 해제했습니다.' });
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 404) onSubs((subs ?? []).filter((x) => x.endpoint !== endpoint));
      else setNote({ ok: false, text: '해제하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!mine) return;
    setBusy('test');
    setNote(null);
    try {
      await api.pushTest(mine);
      setNote({ ok: true, text: '시험 알림을 보냈습니다. 잠시 뒤 알림이 뜨는지 확인해 주세요.' });
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 404) {
        setNote({ ok: false, text: '이 브라우저의 구독이 서버에 없습니다(만료됨). "이 브라우저에서 받기"를 다시 눌러 주세요.' });
        await refresh();
      } else {
        setNote({ ok: false, text: '시험 알림을 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="nt-part" role="group" aria-label="웹 알림">
      <div className="nt-head">
        <h3 className="nt-title">웹 알림</h3>
        {support.ok && <span className={here ? 'tag green' : 'tag neutral'}><span className="dot" />{here ? '이 브라우저에서 받는 중' : '이 브라우저는 꺼짐'}</span>}
      </div>
      <p className="hint nt-lead">텔레그램이 없어도 브라우저 알림으로 받을 수 있습니다. 알림을 누르면 그 세션 상세가 열립니다. 브라우저마다 따로 켭니다.</p>

      {!support.ok && (
        <p className="notice" role="note">
          <InfoIcon size={16} />
          <span>
            {support.reason === 'ios'
              ? '아이폰·아이패드에서는 사파리의 공유 버튼 › "홈 화면에 추가"로 이 사이트를 추가한 뒤, 홈 화면에서 연 앱의 설정에서 켤 수 있습니다.'
              : '이 브라우저는 웹 알림을 지원하지 않습니다. 크롬·엣지·파이어폭스 최신판이나 홈 화면에 추가한 앱에서 켜 주세요.'}
          </span>
        </p>
      )}
      {support.ok && perm === 'denied' && !here && (
        <p className="notice" role="note">
          <InfoIcon size={16} />
          <span>이 브라우저는 이 사이트의 알림을 막아 두었습니다. 주소창 옆 사이트 설정에서 알림을 허용해 주세요.</span>
        </p>
      )}

      {support.ok && (
        <div className="tg-actions">
          {here ? (
            <>
              <button type="button" className="btn" onClick={test} disabled={busy !== null}>시험 알림</button>
              <button type="button" className="btn danger" onClick={() => mine && void remove(mine)} disabled={busy !== null}>해제</button>
            </>
          ) : (
            <button type="button" className="btn primary" onClick={subscribe} disabled={busy !== null}>이 브라우저에서 받기</button>
          )}
        </div>
      )}

      <p className={note ? (note.ok ? 'save-note ok' : 'save-note bad') : 'save-note'} role="status" hidden={!note}>{note?.text}</p>

      <div className="push-list">
        <span className="lbl">이 계정에서 받는 브라우저</span>
        {failed && <p className="hint">목록을 불러오지 못했습니다.</p>}
        {!failed && subs === null && <p className="hint">불러오는 중입니다.</p>}
        {!failed && subs?.length === 0 && <p className="hint">아직 웹 알림을 켠 브라우저가 없습니다.</p>}
        {!!subs?.length && (
          <ul className="share-list" aria-label="웹 알림을 받는 브라우저">
            {subs.map((x) => (
              <li key={x.endpoint}>
                <span className="share-what">
                  <span className="share-name">{x.label || '이름 없는 브라우저'}</span>
                  {x.endpoint === mine && <span className="tag blue">이 브라우저</span>}
                </span>
                <span className="share-meta hint">{formatClock(x.createdAt, now)} 켬</span>
                <button type="button" className="link-btn danger" onClick={() => void remove(x.endpoint)} disabled={busy !== null}
                  aria-label={`${x.label || '브라우저'} 웹 알림 해제`}>해제</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** 웹 알림 소리(이 브라우저에서만). 켜면 한 번 들려준다(누른 동작으로 소리가 풀린다). */
export function SoundRow() {
  const [on, setOn] = useState(isSoundOn);
  const toggle = (v: boolean) => {
    setSoundOn(v);
    setOn(v);
    if (v) {
      unlockSound();
      setTimeout(() => { playChime('done'); }, 60);
    }
  };
  return (
    <div className="sw-row">
      <div className="sw-text">
        <label htmlFor="notify-sound">웹 알림 소리</label>
        <span className="hint" id="notify-sound-hint">이 브라우저에서만 적용됩니다. 대시보드를 열어 둔 동안 세션이 답을 기다리거나 작업이 끝나면 짧게 울립니다(화면을 한 번 누른 뒤부터).</span>
      </div>
      <input
        id="notify-sound"
        className="sw"
        type="checkbox"
        role="switch"
        checked={on}
        aria-describedby="notify-sound-hint"
        onChange={(e) => toggle(e.target.checked)}
      />
    </div>
  );
}
