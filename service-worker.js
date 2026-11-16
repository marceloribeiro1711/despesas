// PROVISÓRIO — migração do service worker antigo do Despesas.
// Aparelhos que ainda têm este arquivo registrado o recebem como atualização:
// ele limpa só os caches 'despesas-casa-*', se desregistra e recarrega a página,
// que então registra o 'service-worker-despesas.js'.
// Depois que todos os aparelhos atualizarem, este arquivo pode ser APAGADO.
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names
          .filter(function (name) { return name.indexOf('despesas-casa-') === 0; })
          .map(function (name) { return caches.delete(name); })
      );
    }).then(function () {
      return self.registration.unregister();
    }).then(function () {
      return self.clients.matchAll({ type: 'window' });
    }).then(function (clients) {
      clients.forEach(function (client) { client.navigate(client.url); });
    })
  );
});
