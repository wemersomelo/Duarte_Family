// Service worker mínimo: permite instalar o app no celular. Não guarda dados da família em cache.
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
