/* Ember service worker (PWA build)
 * 戦略:
 *  - アプリシェル（index.html / manifest / icons）: install時にキャッシュし cache-first で配信。
 *    → オフラインでもアプリが開き、起動時に辞書(ハンドブック＋補助辞書1〜3)が IndexedDB へ seed される。
 *  - WebLLM ライブラリ/wasm の CDN: runtime cache-first。初回オンライン起動後はオフラインでも boot 可能。
 *  - モデルの「重み」: WebLLM 自身が Cache Storage / IndexedDB に保存するため、ここでは管理しない（巨大なので）。
 *  - キャッシュ名は index.html の内容ハッシュを含むため、配信物を更新すると自動的に旧キャッシュが無効化される。
 */
const VERSION = "a599ae842f";
const SHELL_CACHE = "ember-shell-" + VERSION;
const RUNTIME_CACHE = "ember-runtime-" + VERSION;

const SHELL = [
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];

// boot に必要な WebLLM ライブラリ/wasm/モデル設定を配る CDN ホスト（重みのHF等は含めない）
const RUNTIME_HOSTS = ["esm.run", "cdn.jsdelivr.net", "jsdelivr.net", "raw.githubusercontent.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL).then(() => cache.add("./").catch(() => {})))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

function isRuntimeHost(hostname) {
  return RUNTIME_HOSTS.some((h) => hostname === h || hostname.endsWith("." + h));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // ページ遷移: オフライン起動のため index.html を cache-first
  if (req.mode === "navigate") {
    event.respondWith(
      caches.match("./index.html").then((cached) =>
        cached || fetch(req).catch(() => caches.match("./index.html"))
      )
    );
    return;
  }

  // 同一オリジンの静的アセット: cache-first（無ければ取得してシェルキャッシュに保存）
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) =>
        cached || fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        }).catch(() => cached)
      )
    );
    return;
  }

  // WebLLM ライブラリ/wasm/設定 の CDN: runtime cache-first（オフライン boot 用）
  if (isRuntimeHost(url.hostname)) {
    event.respondWith(
      caches.match(req).then((cached) =>
        cached || fetch(req).then((res) => {
          if (res && (res.status === 200 || res.type === "opaque")) {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => cached)
      )
    );
    return;
  }

  // それ以外（モデル重み等）はネットワークへ素通し（WebLLM が独自にキャッシュ）
});
