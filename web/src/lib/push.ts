// 웹 푸시(이 브라우저에서 받기)에 쓰는 도우미. 서비스 워커는 web/public/sw.js.
import * as api from '../api/client';

export const SW_URL = '/sw.js';

export type PushSupport =
  | { ok: true }
  /** ios = 아이폰·아이패드에서 홈 화면에 추가하지 않은 경우(추가한 앱에서만 쓸 수 있다) */
  | { ok: false; reason: 'ios' | 'unsupported' };

function isIos(ua: string): boolean {
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  // 아이패드는 데스크톱 사파리처럼 보이기도 한다(터치 지점이 여러 개면 아이패드).
  return /Macintosh/i.test(ua) && typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 1;
}

function standalone(): boolean {
  try {
    return !!window.matchMedia?.('(display-mode: standalone)').matches
      || (navigator as unknown as { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

export function pushSupport(): PushSupport {
  const w = typeof window !== 'undefined' ? (window as unknown as Record<string, unknown>) : null;
  const ok = !!w && typeof navigator !== 'undefined'
    && !!(navigator as unknown as { serviceWorker?: unknown }).serviceWorker
    && !!w.PushManager && !!w.Notification;
  if (ok) return { ok: true };
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return { ok: false, reason: isIos(ua) && !standalone() ? 'ios' : 'unsupported' };
}

/** 사람이 알아볼 이름. 예: "Chrome · Windows" */
export function browserLabel(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
      : /SamsungBrowser/.test(ua) ? '삼성 인터넷'
        : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
          : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari'
              : '브라우저';
  const os = /Windows/.test(ua) ? 'Windows'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
      : /Android/.test(ua) ? 'Android'
        : /CrOS/.test(ua) ? 'ChromeOS'
          : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
            : /Linux/.test(ua) ? 'Linux'
              : '';
  return os ? `${browser} · ${os}` : browser;
}

/** VAPID 공개 키(base64url) → Uint8Array */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** 이미 등록된 서비스 워커(새로 등록하지 않는다). */
async function existingRegistration(): Promise<ServiceWorkerRegistration | null> {
  try {
    return (await navigator.serviceWorker.getRegistration(SW_URL)) ?? (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

/** 이 브라우저의 지금 구독 endpoint. 없으면 null. */
export async function currentEndpoint(): Promise<string | null> {
  if (!pushSupport().ok) return null;
  const reg = await existingRegistration();
  if (!reg) return null;
  try { return (await reg.pushManager.getSubscription())?.endpoint ?? null; } catch { return null; }
}

/** 브라우저 알림 권한. 지원하지 않으면 null. */
export function notificationPermission(): NotificationPermission | null {
  try { return typeof Notification !== 'undefined' ? Notification.permission : null; } catch { return null; }
}

export type SubscribeResult = { ok: true; endpoint: string } | { ok: false; reason: 'denied' | 'unsupported' | 'failed' };

/** 권한을 묻고, 서비스 워커를 등록하고, 구독해 서버에 알린다. 버튼을 누른 동작 안에서 불러야 한다. */
export async function subscribeThisBrowser(): Promise<SubscribeResult> {
  if (!pushSupport().ok) return { ok: false, reason: 'unsupported' };
  let perm: NotificationPermission;
  try { perm = await Notification.requestPermission(); } catch { return { ok: false, reason: 'failed' }; }
  if (perm !== 'granted') return { ok: false, reason: 'denied' };
  try {
    await navigator.serviceWorker.register(SW_URL);
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api.getPushKey();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
    }
    const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return { ok: false, reason: 'failed' };
    await api.pushSubscribe({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      label: browserLabel(navigator.userAgent).slice(0, 100),
    });
    return { ok: true, endpoint: json.endpoint };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** 이 브라우저 쪽 구독을 끊는다. 서버 쪽은 부르는 곳에서 지운다. */
export async function unsubscribeThisBrowser(): Promise<void> {
  if (!pushSupport().ok) return;
  const reg = await existingRegistration();
  try { await (await reg?.pushManager.getSubscription())?.unsubscribe(); } catch { /* 이미 끊김 */ }
}

/** 알림을 누르면 서비스 워커가 열린 탭에 {type:'open', url}을 보낸다. 같은 사이트 안 주소면 그리로 옮긴다. */
export function listenServiceWorker(go: (to: string) => void): void {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  if (!sw || typeof sw.addEventListener !== 'function') return;
  sw.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: unknown; url?: unknown } | null;
    if (!d || d.type !== 'open' || typeof d.url !== 'string') return;
    try {
      const u = new URL(d.url, window.location.origin);
      if (u.origin === window.location.origin) go(u.pathname + u.search);
    } catch { /* 무시 */ }
  });
}
