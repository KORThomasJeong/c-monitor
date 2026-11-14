// 설정 > 알림: 텔레그램 연결과 알림 항목 스위치. 계약은 shared/src/contract.ts "알림(텔레그램)" 절.
// 스위치·숫자는 저장 단추 없이 바로 저장하고, 실패하면 마지막으로 서버가 확인해 준 값으로 되돌린다.
import type { NotifySettings, NotifyView, TelegramLinkResponse } from '@c-monitor/shared';
import { useEffect, useRef, useState } from 'react';
import * as api from '../api/client';
import { Sec } from '../components/SidePage';
import { formatClock } from '../lib/format';
import { Link } from '../router';

/** 연결될 때까지 다시 묻는 간격 */
export const POLL_MS = 3000;
/** 다시 묻기를 멈추는 최대 시간(연결 코드 유효 시간과 같다) */
export const POLL_MAX_MS = 10 * 60_000;
// 범위는 계약 NotifySettingsSchema.limitPct와 같다.
export const PCT_MIN = 50;
export const PCT_MAX = 100;

type BoolKey = 'wait' | 'done' | 'lost' | 'limit';
const ITEMS: { key: Exclude<BoolKey, 'limit'>; label: string; hint: string }[] = [
  { key: 'wait', label: '답을 기다릴 때', hint: '승인·질문·알림으로 세션이 멈추면 알려 드립니다.' },
  { key: 'done', label: '작업이 끝났을 때', hint: '작업 중이던 세션이 끝나면 알려 드립니다.' },
  { key: 'lost', label: '연락이 끊겼을 때', hint: '세션 소식이 표시 기준보다 오래 없으면 알려 드립니다.' },
];

type Note = { ok: boolean; text: string } | null;
type Pending = TelegramLinkResponse & { deadline: number };

/** 남은 시간을 "9분 58초 남음" 꼴로 */
export function formatLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}분 ${s % 60}초 남음` : `${s}초 남음`;
}

/**
 * 버튼을 누른 그 순간(사용자 동작 안)에 빈 새 탭을 열어 둔다. 링크를 받은 뒤 열면 팝업 차단에 걸린다.
 * 휴대폰(굵은 포인터)에서는 열지 않고 화면의 "텔레그램 열기" 링크를 누르게 한다 —
 * 사람이 직접 누른 https://t.me 링크라야 텔레그램 앱으로 넘어간다.
 */
function preopenTab(): Window | null {
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  if (coarse || typeof window.open !== 'function') return null;
  try { return window.open('', '_blank') ?? null; } catch { return null; }
}

export function NotifySection({ isAdmin = false }: { isAdmin?: boolean }) {
  const [view, setView] = useState<NotifyView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [expired, setExpired] = useState(false);
  const [pct, setPct] = useState('');
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState<null | 'link' | 'test' | 'unlink'>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** 서버가 마지막으로 확인해 준 설정. 저장이 실패하면 이 값으로 되돌린다. */
  const saved = useRef<NotifySettings | null>(null);
  /** 저장 요청 차례. 늦게 도착한 옛 응답이 새 값을 덮지 않게 한다. */
  const saveSeq = useRef(0);

  const apply = (v: NotifyView) => {
    saved.current = v.settings;
    setView(v);
    setPct(String(v.settings.limitPct));
  };

  useEffect(() => {
    let live = true;
    api.getNotify()
      .then((v) => live && apply(v))
      .catch(() => live && setLoadFailed(true));
    return () => { live = false; };
  }, []);

  // 연결 코드를 받은 동안: 3초마다 다시 묻고, 1초마다 남은 시간을 고친다. 화면을 떠나면 멈춘다.
  useEffect(() => {
    if (!pending) return;
    let stop = false;
    let inflight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const schedule = () => { if (!stop) timer = setTimeout(tick, POLL_MS); };
    async function tick() {
      if (stop || inflight) return;
      if (Date.now() >= pending!.deadline) { setPending(null); setExpired(true); return; }
      inflight = true;
      try {
        const v = await api.getNotify();
        if (stop) return;
        if (v.telegram.linked) {
          apply(v);
          setPending(null);
          setNote({ ok: true, text: '연결되었습니다.' });
          return;
        }
      } catch {
        // 잠깐의 실패는 다음 차례에 다시 묻는다.
      } finally {
        inflight = false;
      }
      schedule();
    }
    // 텔레그램에 갔다가 돌아오면 3초를 기다리지 않고 바로 묻는다.
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || inflight) return;
      clearTimeout(timer);
      void tick();
    };
    schedule();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stop = true;
      clearTimeout(timer);
      clearInterval(clock);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pending]);

  const startLink = async () => {
    const tab = preopenTab();
    setBusy('link');
    setNote(null);
    setExpired(false);
    try {
      const l = await api.createTelegramLink();
      const t = Date.now();
      const ttl = Date.parse(l.expiresAt) - t;
      // 서버와 시계가 어긋나 이미 지난 것처럼 보이면 최대 시간으로 둔다.
      const deadline = t + (ttl > 0 ? Math.min(ttl, POLL_MAX_MS) : POLL_MAX_MS);
      setNow(t);
      setPending({ ...l, deadline });
      if (tab) {
        try { tab.opener = null; } catch { /* 무시 */ }
        tab.location.href = l.url;
      }
    } catch (e) {
      tab?.close();
      if (api.errorCode(e) === 'telegram_unavailable') {
        // 그사이 관리자가 봇을 껐다. 상태를 다시 받아 "봇 없음" 안내로 바꾼다.
        api.getNotify().then(apply).catch(() => {});
        return;
      }
      setNote({ ok: false, text: '연결 링크를 받지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
    } finally {
      setBusy(null);
    }
  };

  const cancelLink = () => { setPending(null); setExpired(false); };

  const sendTest = async () => {
    setBusy('test');
    setNote(null);
    try {
      await api.sendTelegramTest();
      setNote({ ok: true, text: '시험 메시지를 보냈습니다. 텔레그램을 확인해 주세요.' });
    } catch (e) {
      if (api.errorCode(e) === 'telegram_unavailable') {
        api.getNotify().then(apply).catch(() => {});
      } else if (api.errorCode(e) === 'not_linked') {
        setNote({ ok: false, text: '텔레그램이 연결되어 있지 않습니다. 다시 연결해 주세요.' });
        api.getNotify().then(apply).catch(() => {});
      } else {
        setNote({ ok: false, text: '시험 메시지를 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
      }
    } finally {
      setBusy(null);
    }
  };

  const unlink = async () => {
    if (!confirmUnlink) { setConfirmUnlink(true); return; }
    setConfirmUnlink(false);
    setBusy('unlink');
    setNote(null);
    try {
      apply(await api.unlinkTelegram());
      setNote({ ok: true, text: '텔레그램 연결을 끊었습니다.' });
    } catch {
      setNote({ ok: false, text: '연결을 끊지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
    } finally {
      setBusy(null);
    }
  };

  /** 한 항목을 바꿔 바로 저장한다. 실패하면 마지막으로 확인된 값으로 되돌린다. */
  const save = async (patch: Partial<NotifySettings>) => {
    if (!view) return;
    const next = { ...view.settings, ...patch };
    const seq = ++saveSeq.current;
    setView({ ...view, settings: next });
    setNote(null);
    try {
      const res = await api.putNotifySettings(next);
      if (seq !== saveSeq.current) return;
      if (res && res.settings) apply(res);
      else saved.current = next;
    } catch {
      if (seq !== saveSeq.current) return;
      const back = saved.current;
      if (back) {
        setView((v) => (v ? { ...v, settings: back } : v));
        setPct(String(back.limitPct));
      }
      setNote({ ok: false, text: '알림 설정을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
    }
  };

  const commitPct = () => {
    if (!view) return;
    const cur = view.settings.limitPct;
    const n = Number(pct);
    if (pct.trim() === '' || !Number.isInteger(n) || n < PCT_MIN || n > PCT_MAX) {
      setPct(String(cur));
      setNote({ ok: false, text: `한도 기준에는 ${PCT_MIN}부터 ${PCT_MAX}까지의 정수를 넣어 주세요.` });
      return;
    }
    if (n !== cur) void save({ limitPct: n });
  };

  const tg = view?.telegram;
  const linked = !!tg?.linked;
  const off = !linked;
  const s = view?.settings;
  const shownPct = s?.limitPct ?? 80;

  const aside = tg?.available
    ? <span className={linked ? 'tag green' : 'tag neutral'}><span className="dot" />{linked ? '연결됨' : '연결 안 됨'}</span>
    : undefined;

  const noteEl = (
    <p className={note ? (note.ok ? 'save-note ok' : 'save-note bad') : 'save-note'} role="status" hidden={!note}>
      {note?.text}
    </p>
  );

  let body;
  if (loadFailed) {
    body = <p className="hint">알림 설정을 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.</p>;
  } else if (!view || !tg || !s) {
    body = <p className="hint">불러오는 중입니다.</p>;
  } else if (!tg.available) {
    body = (
      <p className="notice tg-none" role="note">
        서버에 텔레그램 봇이 설정되지 않았습니다.{' '}
        {isAdmin
          ? <><Link to="/admin#notify">관리 › 알림</Link>에서 봇 토큰을 넣어 주세요.</>
          : '관리자에게 텔레그램 봇 설정을 요청하세요.'}
      </p>
    );
  } else {
    body = (
      <>
        <div className="tg-box">
          {linked ? (
            <>
              <div className="dl">
                <div className="dl-row"><span className="k">연결된 계정</span><span className="v">{tg.linkedName ?? '—'}</span></div>
                <div className="dl-row"><span className="k">연결한 시각</span><span className="v">{formatClock(tg.linkedAt, now)}</span></div>
                {tg.botUsername && (
                  <div className="dl-row"><span className="k">알림 봇</span><span className="v">@{tg.botUsername}</span></div>
                )}
              </div>
              <div className="tg-actions">
                <button type="button" className="btn" onClick={sendTest} disabled={busy !== null}>시험 메시지 보내기</button>
                <button
                  type="button"
                  className="btn danger"
                  onClick={unlink}
                  onBlur={() => setConfirmUnlink(false)}
                  disabled={busy !== null}
                >
                  {confirmUnlink ? '끊기 확인' : '연결 끊기'}
                </button>
              </div>
            </>
          ) : pending ? (
            <div className="tg-wait">
              <p className="tg-lead">텔레그램에서 시작을 누르면 연결됩니다.</p>
              <div className="code-big tg-code" aria-label="연결 코드">{pending.code}</div>
              <span className="hint" role="timer">{formatLeft(pending.deadline - now)}</span>
              <div className="tg-actions">
                <a className="btn primary" href={pending.url} target="_blank" rel="noopener noreferrer">텔레그램 열기</a>
                <button type="button" className="btn" onClick={cancelLink}>취소</button>
              </div>
              <p className="hint">
                텔레그램이 열리지 않으면 {tg.botUsername ? <b>@{tg.botUsername}</b> : '알림 봇'}에게{' '}
                <code className="tg-cmd">/start {pending.code}</code>를 보내 주세요.
              </p>
            </div>
          ) : (
            <div className="tg-wait">
              <p className="tg-lead">
                {expired
                  ? '연결 코드가 만료되었습니다. 코드를 다시 받아 주세요.'
                  : '텔레그램을 연결하면 세션 소식을 휴대폰으로 받을 수 있습니다.'}
              </p>
              <div className="tg-actions">
                <button type="button" className="btn primary" onClick={startLink} disabled={busy !== null}>
                  {expired ? '코드 다시 받기' : '텔레그램 연결'}
                </button>
              </div>
            </div>
          )}
        </div>

        {noteEl}

        <div className="sw-list">
          {off && <p className="hint" id="notify-off">텔레그램을 연결하면 알림 항목을 고를 수 있습니다.</p>}
          {ITEMS.map((it) => (
            <div className="sw-row" key={it.key}>
              <div className="sw-text">
                <label htmlFor={`notify-${it.key}`}>{it.label}</label>
                <span className="hint" id={`notify-${it.key}-hint`}>{it.hint}</span>
              </div>
              <input
                id={`notify-${it.key}`}
                className="sw"
                type="checkbox"
                role="switch"
                checked={s[it.key]}
                disabled={off}
                aria-describedby={off ? `notify-${it.key}-hint notify-off` : `notify-${it.key}-hint`}
                onChange={(e) => void save({ [it.key]: e.target.checked })}
              />
            </div>
          ))}
          <div className="sw-row">
            <div className="sw-text">
              <label htmlFor="notify-limit">한도가 {shownPct}%를 넘을 때</label>
              <span className="hint" id="notify-limit-hint">5시간·주간 한도 중 하나라도 넘으면 알려 드립니다.</span>
              <span className="inline pct-line">
                <label htmlFor="notify-pct" className="hint">기준</label>
                <input
                  id="notify-pct"
                  className="input num pct-input"
                  type="number"
                  inputMode="numeric"
                  min={PCT_MIN}
                  max={PCT_MAX}
                  step={1}
                  aria-label={`한도 알림 기준(${PCT_MIN}~${PCT_MAX}%)`}
                  value={pct}
                  disabled={off}
                  onChange={(e) => setPct(e.target.value)}
                  onBlur={commitPct}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitPct(); } }}
                />
                <span className="hint">%</span>
              </span>
            </div>
            <input
              id="notify-limit"
              className="sw"
              type="checkbox"
              role="switch"
              checked={s.limit}
              disabled={off}
              aria-describedby={off ? 'notify-limit-hint notify-off' : 'notify-limit-hint'}
              onChange={(e) => void save({ limit: e.target.checked })}
            />
          </div>
        </div>

        <p className="notice">승인·질문 알림에서는 버튼으로 바로 답할 수 있고, 알림에 답장으로 글을 쓰면 그 세션에 전달됩니다.</p>
      </>
    );
  }

  return (
    <Sec id="notify" title="알림" desc="텔레그램으로 세션 소식을 받습니다. 바꾸면 바로 저장됩니다." aside={aside} body>
      {body}
      {(!tg?.available || loadFailed) && noteEl}
    </Sec>
  );
}
