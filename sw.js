/* ===== LogNavAK — service worker : application utilisable hors-ligne =====
   À la PREMIÈRE utilisation en ligne, l'application et toutes ses
   bibliothèques sont téléchargées dans le cache (liste PRECACHE) ; l'app
   s'ouvre ensuite en mode avion, avec les cartes téléchargées.
   - index.html : réseau d'abord (pour recevoir les mises à jour), cache en
     secours hors-ligne.
   - autres ressources : cache d'abord (?v= ignoré), réseau + mise en cache
     sinon.
   - EXCLUS : tuiles de carte (OSM / Google / IGN — gérées par l'outil
     hors-ligne de l'app) et fichiers .pmtiles (copie IndexedDB dédiée).
   À maintenir : si une bibliothèque change de version dans index.html,
   reporter l'URL ici et incrémenter CACHE. */
const CACHE = 'lognav-app-v2';
const PRECACHE = [
  './',
  './index.html',
  './ELEV_FR.js?v=2026-07-22',
  './POI_FR.js?v=2026-07-21',
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/Turf.js/6.5.0/turf.min.js',
  'https://cdn.jsdelivr.net/npm/pocketbase@0.22.0/dist/pocketbase.umd.js',
  'https://unpkg.com/pmtiles@3.2.0/dist/pmtiles.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500&family=Space+Mono:wght@400;700&display=swap'
];
const SKIP = [
  /aviationweather\.gov/i,
  /corsproxy\.io/i,
  /allorigins\.win/i,
  /api\.met\.no/i,
  /open-meteo\.com/i,
  /\.pmtiles(\?|$)/i,
  /tile\.openstreetmap\.org/i,
  /mt\d\.google(?:apis)?\.com/i,
  /data\.geopf\.fr/i,
  /overpass/i,
  /akila-flight\.fr/i,
  /supabase/i,
  /pocketbase\.io/i
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    /* tolérant : une ressource injoignable n'empêche pas les autres */
    await Promise.allSettled(PRECACHE.map(u => c.add(u)));
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const ks = await caches.keys();
    await Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (SKIP.some(rx => rx.test(url))) return;

  /* Navigation (index.html) : réseau d'abord, cache en secours.
     Wi-Fi sans internet : le réseau ne doit pas bloquer (délai 3,5 s puis cache).
     Portail captif : une réponse redirigée hors origine ou non-200 est refusée
     (jamais mise en cache à la place de l'app, jamais affichée). */
  if (req.mode === 'navigate' || /\/index\.html(\?|$)/.test(url)) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const cached = (await c.match(req, { ignoreSearch: true })) ||
                     (await c.match('./index.html')) ||
                     (await c.match('./'));
      try {
        const ctl = new AbortController();
        const tm = setTimeout(() => ctl.abort(), cached ? 3500 : 12000);
        const r = await fetch(req, { signal: ctl.signal });
        clearTimeout(tm);
        let sameOrigin = false;
        try { sameOrigin = new URL(r.url).origin === self.location.origin; } catch (_) {}
        if (r && r.ok && sameOrigin && !r.redirected) { c.put(req, r.clone()); return r; }
        throw new Error('réponse invalide (portail captif ?)');
      } catch (_) {
        return cached || Response.error();
      }
    })());
    return;
  }

  /* Ressources : cache d'abord (?v= ignoré), réseau + mise en cache sinon.
     Délai 8 s, et une ressource locale répondue par un portail captif
     (redirection hors origine) n'est jamais mise en cache. */
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(req, { signal: ctl.signal });
      clearTimeout(tm);
      const localReq = url.indexOf(self.location.origin) === 0;
      let portal = false;
      if (localReq) { try { portal = new URL(r.url).origin !== self.location.origin; } catch (_) { portal = true; } }
      if (r && !portal && (r.ok || r.type === 'opaque')) c.put(req, r.clone());
      return r;
    } catch (err) {
      return Response.error();
    }
  })());
});
