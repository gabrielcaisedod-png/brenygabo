/* Bren & Gabo · service worker: app offline, fotos privadas y notificaciones */
importScripts("/config.js");
const CFG = self.APP_CONFIG || {};
const SHELL = "byg-shell-v1";
const MEDIA = "byg-media-v1";
const SHELL_FILES = ["/", "/shim.js", "/config.js", "/vendor/supabase.js", "/vendor/jszip.min.js", "/manifest.webmanifest", "/icon-192.png"];

let TOKEN = null;
let waiters = [];

self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).catch(() => {}));
});
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== MEDIA) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener("message", e => {
  if (e.data && e.data.type === "token") {
    TOKEN = e.data.token;
    waiters.forEach(w => w(TOKEN)); waiters = [];
  }
});

async function freshToken() {
  const cs = await self.clients.matchAll({ type: "window" });
  if (!cs.length) return TOKEN;
  const p = new Promise(r => { waiters.push(r); setTimeout(() => r(TOKEN), 4000); });
  cs.forEach(c => c.postMessage({ type: "need-token" }));
  return p;
}

async function blobResponse(req, id) {
  const cache = await caches.open(MEDIA);
  let res = await cache.match("/_blob/" + id);
  if (!res) {
    let token = TOKEN || await freshToken();
    const url = CFG.supabaseUrl + "/storage/v1/object/authenticated/media/" + id;
    let r = await fetch(url, { headers: { Authorization: "Bearer " + token, apikey: CFG.anonKey } });
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      token = await freshToken();
      r = await fetch(url, { headers: { Authorization: "Bearer " + token, apikey: CFG.anonKey } });
    }
    if (!r.ok) return new Response("", { status: r.status });
    const blob = await r.blob();
    const type = r.headers.get("Content-Type") || blob.type || "application/octet-stream";
    res = new Response(blob, { headers: { "Content-Type": type, "Content-Length": String(blob.size) } });
    await cache.put("/_blob/" + id, res.clone());
  }
  const range = req.headers.get("Range");
  if (!range) return res;
  const blob = await res.blob();
  const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
  const size = blob.size;
  let start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : size - 1;
  if (!m[1] && m[2]) { start = size - parseInt(m[2], 10); end = size - 1; }
  end = Math.min(end, size - 1);
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: { "Content-Type": blob.type, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes" }
  });
}

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/_blob/")) {
    const id = url.pathname.slice(7).replace(/[^a-f0-9]/gi, "");
    e.respondWith(blobResponse(e.request, id));
    return;
  }
  if (url.pathname.startsWith("/api/")) return;
  if (e.request.method !== "GET") return;
  // app: primero red (para tener siempre la última versión), si no hay conexión usa la copia
  e.respondWith((async () => {
    try {
      const r = await fetch(e.request);
      if (r.ok && (e.request.mode === "navigate" || SHELL_FILES.includes(url.pathname))) {
        const c = await caches.open(SHELL); c.put(e.request.mode === "navigate" ? "/" : e.request, r.clone());
      }
      return r;
    } catch (err) {
      const c = await caches.open(SHELL);
      return (await c.match(e.request.mode === "navigate" ? "/" : e.request)) || Response.error();
    }
  })());
});

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data.json(); } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Bren & Gabo", {
    body: d.body || "Hay algo nuevo 💞",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: d.tag || undefined,
    data: { url: d.url || "/" }
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of cs) { if ("focus" in c) return c.focus(); }
    return self.clients.openWindow((e.notification.data && e.notification.data.url) || "/");
  })());
});
