// NiceShot: service worker. Guarda só a "casca" do app para abrir offline.
// A API (Worker) e as fotos nunca são guardadas aqui. Ao mudar arquivos do app, aumente o número em V.
const V = "niceshot-v1";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  // só arquivos do próprio app; a API, as fotos, o Instagram e o admin passam direto pela rede
  if (r.method !== "GET" || u.origin !== location.origin || u.pathname.endsWith("/admin.html")) return;
  if (r.mode === "navigate") { // página: rede primeiro (sempre a versão nova); sem rede, a guardada
    e.respondWith(fetch(r).then(res => { const cp = res.clone(); caches.open(V).then(c => c.put("index.html", cp)); return res; }).catch(() => caches.match("index.html")));
    return;
  }
  e.respondWith(caches.match(r).then(hit => hit || fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); } return res; })));
});
