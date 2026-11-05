// Service worker de Ciné IDF : l'app reste utilisable sans réseau (métro, PC
// éteint) avec les dernières séances récupérées.
//
// - Données (/api/...) : réseau d'abord, avec un délai court ; sans réponse,
//   la dernière copie gardée. Chaque réponse réussie remplace la copie.
// - Page, script, styles : pareil (réseau d'abord) — une mise à jour de l'app
//   s'applique tout de suite, la copie ne sert que hors ligne.
// - Affiches (images AlloCiné) : copie d'abord, elles ne changent pas.
// Ne passent jamais par ici : la connexion témoin (/api/alive) et tout ce qui
// n'est pas une lecture (POST : mise à jour, panier, watchlist…).

const VERSION = 'cine-idf-v1';
const DONNEES = `${VERSION}-donnees`;
const AFFICHES = `${VERSION}-affiches`;
const COQUILLE = ['/', '/app.js', '/style.css', '/icon.png', '/manifest.webmanifest'];
const DELAI_RESEAU = 4000;   // au-delà, on sert la copie (réseau mobile poussif)
const MAX_AFFICHES = 600;

// Une mise à jour (et non la toute première installation) : les pages déjà
// ouvertes tournent sur l'ancien code, on les recharge à l'activation.
let miseAJour = false;

self.addEventListener('install', (e) => {
  miseAJour = Boolean(self.registration.active);
  e.waitUntil(caches.open(DONNEES).then((c) => c.addAll(COQUILLE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (!k.startsWith(VERSION)) await caches.delete(k);
    await self.clients.claim();
    if (miseAJour) {
      for (const c of await self.clients.matchAll({ type: 'window' })) {
        try { await c.navigate(c.url); } catch { /* navigateur qui ne sait pas faire : tant pis */ }
      }
    }
  })());
});

const COQUILLE_CHEMINS = new Set(['/', '/app.js', '/style.css']);

/** Prévient la page qu'elle affiche une copie (pour le bandeau « hors ligne »). */
async function signaler(horsLigne) {
  for (const c of await self.clients.matchAll()) c.postMessage({ type: 'cine-reseau', horsLigne });
}

async function reseauPuisCopie(req) {
  const cache = await caches.open(DONNEES);
  // La réponse continue même si on a déjà servi la copie : réseau lent, elle
  // arrive quand même, et la prochaine ouverture sera à jour.
  const reseau = fetch(req).then(async (res) => {
    if (res.ok) {
      await cache.put(req, res.clone());
      signaler(false);
    }
    return res;
  });
  const copieDe = async () => {
    const copie = await cache.match(req, { ignoreSearch: req.url.includes('/api/') ? false : true });
    if (copie) return copie;
    // Page demandée sans copie : la coquille, pour au moins ouvrir l'app.
    return req.mode === 'navigate' ? cache.match('/') : null;
  };
  const horsLigne = () => new Response(JSON.stringify({ error: 'hors-ligne' }), {
    status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

  const delai = new Promise((ok) => setTimeout(ok, DELAI_RESEAU, 'delai'));
  try {
    const premier = await Promise.race([reseau, delai]);
    if (premier !== 'delai') return premier;
  } catch {
    const copie = await copieDe();
    if (copie) signaler(true);
    return copie || horsLigne();
  }
  // Réseau lent. Avec une copie on la sert tout de suite ; sans copie, on attend
  // le réseau plutôt que d'annoncer à tort qu'il n'y a rien (première ouverture).
  const copie = await copieDe();
  if (copie) {
    signaler(true);
    // Vieille copie de l'app servie : si la version arrivée ensuite est différente,
    // la page est prévenue et se recharge dès qu'elle n'est pas occupée.
    const chemin = new URL(req.url).pathname;
    reseau.then(async (res) => {
      if (!res.ok || !COQUILLE_CHEMINS.has(chemin)) return;
      if (res.headers.get('etag') && res.headers.get('etag') !== copie.headers.get('etag')) {
        for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'cine-maj' });
      }
    }).catch(() => {});
    return copie;
  }
  return reseau.catch(horsLigne);
}

async function copiePuisReseau(req) {
  const cache = await caches.open(AFFICHES);
  const copie = await cache.match(req);
  if (copie) return copie;
  try {
    const res = await fetch(req);
    // Réponses « opaques » (autre site) : on les garde aussi, elles s'affichent.
    if (res.ok || res.type === 'opaque') {
      await cache.put(req, res.clone());
      const cles = await cache.keys();
      for (const k of cles.slice(0, Math.max(0, cles.length - MAX_AFFICHES))) await cache.delete(k);
    }
    return res;
  } catch {
    return new Response('', { status: 504 });
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Flux continu et états en direct : jamais en copie (une copie de « mise à
  // jour en cours » ferait croire qu'elle ne finit jamais).
  if (['/api/alive', '/api/refresh', '/api/ping', '/api/version', '/api/agenda.ics'].includes(url.pathname)) return;
  if (req.destination === 'image' && url.origin !== self.location.origin) {
    e.respondWith(copiePuisReseau(req));
    return;
  }
  if (url.origin !== self.location.origin) return;
  e.respondWith(reseauPuisCopie(req));
});
