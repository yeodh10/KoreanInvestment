// AutoTrade KR — PWA 서비스워커
// 금융 앱이라 데이터는 항상 최신이어야 한다 → API·SSE·POST는 절대 캐시하지 않고 네트워크 직결.
// 정적 셸(/, 아이콘, manifest)만 "네트워크 우선, 실패 시 캐시"로 오프라인/순간단절에도 화면이 뜨게 한다.
const CACHE = 'autotrade-shell-v2';
const SHELL = ['/', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  // API·실시간·비-GET·교차출처는 서비스워커가 손대지 않는다(항상 네트워크 직결, 최신 보장).
  if (req.method !== 'GET' || url.origin !== self.location.origin ||
      url.pathname.startsWith('/api/') || url.pathname.startsWith('/events') || url.pathname.startsWith('/sse')) {
    return;
  }
  // 정적 셸: 네트워크 우선 → 받아오면 캐시 갱신, 네트워크 실패 시 캐시 폴백.
  e.respondWith(
    fetch(req).then(resp => {
      if (resp && resp.ok) { const copy = resp.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return resp;
    }).catch(() => caches.match(req).then(m => m || caches.match('/')))
  );
});
