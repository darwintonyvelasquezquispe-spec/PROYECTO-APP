/**
 * DarkMan - Progressive Web App Service Worker
 * 
 * Gestiona el caché de la interfaz para apertura instantánea en celulares,
 * funcionamiento sin conexión para el shell de la aplicación y actualización fluida.
 */

const CACHE_NAME = 'darkman-shell-v1.2.0';

const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/css/custom.css',
  '/manifest.json',
  '/assets/logo.svg',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-maskable.png'
];

// Instalación: Precargar shell de la aplicación
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('Algunos recursos estáticos no pudieron precargarse:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// Activación: Limpieza de cachés antiguas
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Interceptar peticiones (Fetch)
self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  // Las peticiones de API (/api/*) van SIEMPRE a la red primero (Network First)
  // para garantizar datos frescos y consistentes
  if (requestUrl.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch((err) => {
        // Si no hay conexión a internet al llamar a una API,
        // responder con JSON de error de red sin fingir que se guardó
        return new Response(
          JSON.stringify({
            offline: true,
            error: 'Sin conexión a internet. No se pudo comunicar con el servidor de DarkMan.'
          }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      })
    );
    return;
  }

  // Para recursos estáticos (HTML, CSS, JS, imágenes, fuentes): Stale-While-Revalidate
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Si falla la red y no hay caché, retornar página básica de fallback
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });

      return cachedResponse || fetchPromise;
    })
  );
});

// Mensajes recibidos de la aplicación (ej. forzar actualización)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
