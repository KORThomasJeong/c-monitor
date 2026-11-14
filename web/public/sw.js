// C-Monitor 웹 알림 서비스 워커. 서버가 보낸 푸시를 알림으로 띄우고, 누르면 그 세션 상세를 연다.
// 푸시 본문(JSON): { title, body, url, tag } — url은 "/?session=<id>" 꼴. 없는 값은 기본값으로 채운다.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

/** 같은 사이트 안 경로만 받는다("//다른곳" 차단). */
function safePath(v) {
  return typeof v === 'string' && v.charAt(0) === '/' && v.charAt(1) !== '/' && v.indexOf('\\') < 0 ? v : '/';
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    try { data = { body: event.data ? event.data.text() : '' }; } catch (e2) { data = {}; }
  }
  if (!data || typeof data !== 'object') data = {};
  const title = typeof data.title === 'string' && data.title ? data.title : 'C-Monitor';
  const tag = typeof data.tag === 'string' && data.tag ? data.tag : undefined;
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    tag: tag,
    renotify: !!tag,
    data: { url: safePath(data.url) },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = safePath(event.notification.data && event.notification.data.url);
  const target = new URL(path, self.location.origin).href;
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 1) 그 주소로 열린 탭이 있으면 그 탭을 앞으로
    for (const c of list) {
      if (c.url === target && 'focus' in c) return c.focus();
    }
    // 2) 이 사이트 탭이 있으면 앞으로 가져와 그 세션으로 옮기게 한다(웹 화면이 message를 받아 주소를 바꾼다)
    for (const c of list) {
      let same = false;
      try { same = new URL(c.url).origin === self.location.origin; } catch (e) { same = false; }
      if (same && 'focus' in c) {
        await c.focus();
        c.postMessage({ type: 'open', url: path });
        return undefined;
      }
    }
    // 3) 없으면 새 창
    if (self.clients.openWindow) return self.clients.openWindow(target);
    return undefined;
  })());
});
