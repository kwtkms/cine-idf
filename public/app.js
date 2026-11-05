'use strict';

const DEPTS = [
  ['75', 'Paris'], ['77', 'Seine-et-Marne'], ['78', 'Yvelines'], ['91', 'Essonne'],
  ['92', 'Hauts-de-Seine'], ['93', 'Seine-Saint-Denis'], ['94', 'Val-de-Marne'], ['95', "Val-d'Oise"],
];
const PAGE = 40;

const $ = (sel) => document.querySelector(sel);
const load = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } };
// Listes perso partagées entre le PC et le téléphone (via le serveur du PC).
const PERSO = { 'cineidf.cart': 'cart', 'cineidf.favs': 'favs', 'cineidf.wlLocal': 'wlLocal', 'cineidf.wlPerso': 'wlPerso' };
let appliquantPerso = false;
const save = (k, v) => {
  const texte = JSON.stringify(v);
  const avant = localStorage.getItem(k);
  localStorage.setItem(k, texte);
  // Un vrai changement fait ici (pas une copie reçue du serveur) : à envoyer.
  if (PERSO[k] && !appliquantPerso && avant !== texte) noterPerso();
};

const state = {
  index: null,
  theaters: [],
  byId: new Map(),
  date: null,
  day: null,
  view: load('cineidf.view', 'films'),
  sort: load('cineidf.sort', 'popular'),
  sheetMode: load('cineidf.sheetMode', 'heure'), // panneau : « heure » ou « salle »
  panel: null,                                   // écran ouvert : 'cart', 'filters' ou null
  limit: PAGE,
  favs: new Set(load('cineidf.favs', [])),
  origin: load('cineidf.origin', null),        // { lat, lon, label }
  watchlist: load('cineidf.watchlist', null),  // [{ title, year, slug }] issu de Letterboxd
  lbStatus: null,                              // synchro auto : { pseudo, at, ok, error, count }
  lbSyncing: false,
  wlImportedAt: load('cineidf.wlDate', null),  // quand le CSV a été importé
  wlLocal: new Set(load('cineidf.wlLocal', [])), // films cochés depuis une fiche à l'affiche
  wlPerso: load('cineidf.wlPerso', []),          // films saisis à la main, même absents de l'affiche
  ratings: {},                                 // notes Letterboxd par id de film
  cart: load('cineidf.cart', []),              // séances mises de côté
  cartKeys: new Set(),
  wlHits: new Set(),                           // ids des films du jour présents dedans
  filters: Object.assign(
    { q: '', depts: [], city: '', theater: '', version: '', from: '', to: '', genre: '', onlyFav: false, hidePast: true, hidePreview: false, radius: '', onlyWatchlist: false, ugcOnly: true, minNote: false },
    load('cineidf.filters', {}),
  ),
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------------------------------------------------- recherche floue */

// Sans accents, sans ponctuation : "Panthéon" et "pantheon" doivent se valoir.
const norm = (s) => String(s ?? '')
  .normalize('NFD').replace(/\p{Mn}/gu, '') // marques diacritiques décomposées
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Pour la recherche, « st » vaut « saint » : « St Germain » trouve « Saint-Germain ».
const ABREGES = { st: 'saint', ste: 'sainte' };
const normRecherche = (s) => norm(s).split(' ').map((w) => ABREGES[w] || w).join(' ');

/**
 * Distance d'édition bornée, sortie anticipée. Deux lettres inversées comptent
 * pour une seule faute : « siant » trouve « saint ».
 */
function withinEdit(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let avant = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let bestPrev = 0;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
      if (avant && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], avant[j - 2] + 1);
      if (cur[j] < best) best = cur[j];
    }
    // Une inversion peut encore s'appuyer sur la ligne d'avant : on attend que les deux dépassent.
    if (best > max && bestPrev > max) return false;
    avant = prev;
    prev = cur;
    bestPrev = best;
  }
  return prev[b.length] <= max;
}

/**
 * Bitmask des mots de la requête trouvés dans `hay`.
 * Sous-chaîne d'abord (donc "panth" trouve "pantheon"), puis tolérance aux
 * fautes de frappe mot à mot : "chunking" doit trouver "chungking".
 */
function tokenMask(hay, tokens) {
  const words = hay.split(' ');
  const flat = hay.replace(/ /g, ''); // pour "spiderman" -> "Spider-Man", "starwars"...
  let mask = 0;
  tokens.forEach((tk, i) => {
    if (hay.includes(tk) || flat.includes(tk)) { mask |= 1 << i; return; }
    const tol = tk.length >= 8 ? 2 : tk.length >= 4 ? 1 : 0;
    if (tol && words.some((w) => withinEdit(w, tk, tol))) mask |= 1 << i;
  });
  return mask;
}

/** Masques pré-calculés pour la requête courante (films et cinémas). */
function searchIndex(day = state.day) {
  const q = normRecherche(state.filters.q);
  const cacheKey = `${q}|${day?.date}`;
  if (state.search?.key === cacheKey) return state.search;

  const tokens = q ? q.split(' ').slice(0, 8) : [];
  const movies = new Map();
  const theaters = new Map();

  if (tokens.length && day) {
    for (const m of Object.values(day.movies)) {
      const hay = [
        m.title, m.originalTitle,
        (m.genres || []).join(' '),
        (m.directors || []).join(' '),
        (m.cast || []).join(' '),
      ].filter(Boolean).join(' ');
      movies.set(m.id, tokenMask(normRecherche(hay), tokens));
    }
    for (const t of state.theaters) {
      theaters.set(t.id, tokenMask(normRecherche(`${t.name} ${t.city} ${t.address}`), tokens));
    }
  }
  const index = { key: cacheKey, tokens, full: (1 << tokens.length) - 1, movies, theaters };
  if (day === state.day) state.search = index;
  return index;
}
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

/**
 * Minutes depuis minuit. Le fichier d'une journée couvre une journée civile :
 * une séance à 00:30 y a bien eu lieu à 0 h 30 ce matin-là, pas la nuit suivante.
 * Toute comparaison horaire passe par ici.
 */
function slot(hhmm) {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/* ---------------------------------------------------------------- panier */

/**
 * Les séances mises de côté pendant qu'on parcourt la liste. On stocke tout ce
 * qu'il faut pour les afficher (titre, salle, ville) : le panier reste lisible
 * même quand on change de date ou que les données sont rafraîchies.
 */
const cartKey = (s) => `${s.d}|${s.t}|${s.m}|${s.s}|${s.v}`;

function cartHas(date, show) {
  return state.cartKeys.has(`${date}|${show.t}|${show.m}|${show.s}|${show.v}`);
}

function cartToggle(date, show) {
  const t = state.byId.get(show.t);
  const m = state.day?.movies[show.m];
  const item = {
    d: date, t: show.t, m: show.m, s: show.s, v: show.v, u: show.u || null, r: m?.runtime || null,
    titre: m?.title ?? '', salle: t?.name ?? '', ville: t?.city ?? '',
  };
  const k = cartKey(item);

  const retiree = state.cartKeys.has(k);
  if (retiree) state.cart = state.cart.filter((x) => cartKey(x) !== k);
  else state.cart = [...state.cart, item];

  state.cartKeys = new Set(state.cart.map(cartKey));
  save('cineidf.cart', state.cart);
  renderCart();
  if (!retiree) toast(`Gardée : ${item.s}, ${item.titre}`, () => { cartToggle(date, show); syncChips(); });
}

/** Chronologique : date puis heure. */
const cartSorted = () => [...state.cart].sort((a, b) => a.d.localeCompare(b.d) || slot(a.s) - slot(b.s));

const cartPassee = (x) => `${x.d} ${x.s}` < `${todayStr()} ${nowHHMM()}`;

/** Adresse d'itinéraire : Plans sur iPhone, Google Maps ailleurs. */
function lienCarte(t) {
  const q = encodeURIComponent(`${t.name} ${t.address || t.city || ''}`);
  return /iPhone|iPad/.test(navigator.userAgent)
    ? `https://maps.apple.com/?q=${q}`
    : `https://www.google.com/maps/search/?api=1&query=${q}`;
}

/** Une séance en une phrase, pour l'envoyer à quelqu'un. */
function phraseSeance(x) {
  const [label, num] = fmtDate(x.d);
  return `${x.titre}, ${label} ${num} à ${x.s.replace(':', 'h')} (${x.v}), ${x.salle}${x.ville ? `, ${x.ville}` : ''}`;
}

/** Fin de la séance en minutes depuis minuit, si on connaît la durée du film. */
function finSeance(x) {
  const duree = x.r || dayCache.get(x.d)?.movies?.[x.m]?.runtime;
  return duree ? slot(x.s) + duree : null;
}

/** « 1 h 20 », « 45 min » : l'écart entre deux séances. */
function fmtDuree(min) {
  const h = Math.floor(min / 60);
  return h ? `${h} h${min % 60 ? ` ${String(min % 60).padStart(2, '0')}` : ''}` : `${min} min`;
}

/**
 * Une séance gardée qui a disparu du programme, ou qu'AlloCiné ne confirme plus :
 * il vaut mieux le savoir avant de traverser Paris. Seulement si la journée est
 * chargée (sinon on ne sait pas).
 */
function alerteSeance(x) {
  if (cartPassee(x)) return '';
  const jour = dayCache.get(x.d);
  if (!jour) return '';
  const vue = jour.shows.find((s) => s.t === x.t && s.m === x.m && s.s === x.s && s.v === x.v);
  if (!vue) return '<div class="cart-warn">N\'apparaît plus sur AlloCiné : à vérifier sur la billetterie.</div>';
  return vue.x ? '<div class="cart-warn">AlloCiné ne confirme plus cette séance : à vérifier sur la billetterie.</div>' : '';
}

/** Entre deux séances d'un même jour : le temps qu'il reste, ou le chevauchement. */
function entreDeux(a, b) {
  const fin = finSeance(a);
  if (fin == null) return '';
  const ecart = slot(b.s) - fin;
  if (ecart < 0) return `<div class="cart-gap warn">Chevauche la séance suivante de ${fmtDuree(-ecart)}</div>`;
  const ta = state.byId.get(a.t), tb = state.byId.get(b.t);
  const km = a.t !== b.t && Number.isFinite(ta?.lat) && Number.isFinite(tb?.lat) ? haversine(ta.lat, ta.lon, tb.lat, tb.lon) : null;
  return `<div class="cart-gap">${fmtDuree(ecart)} entre les deux${km != null ? `, à ${fmtKm(km)}` : a.t === b.t ? ', même cinéma' : ''}</div>`;
}

function cartItemHTML(x) {
  const t = state.byId.get(x.t);
  const passee = cartPassee(x);
  const fin = finSeance(x);
  const agenda = new URLSearchParams({ titre: x.titre, salle: x.salle, adresse: t?.address || x.ville || '', debut: `${x.d}T${x.s}`, duree: x.r || '' });
  return `<div class="cart-item${passee ? ' past' : ''}">
    <div class="cart-when">${esc(x.s)}<em>${esc(x.v)}</em></div>
    <div class="cart-what">
      <div class="cart-title">${esc(x.titre)}</div>
      <div class="muted small">${esc(x.salle)}${x.ville ? ` · ${esc(x.ville)}` : ''}</div>
      ${fin != null && !passee ? `<div class="muted small">Fin vers ${fmtSlot(fin % 1440)}, sans les pubs</div>` : ''}
      ${alerteSeance(x)}
      ${passee ? '' : `<div class="cart-actions">
        ${x.u ? `<a class="btn ghost small" href="${esc(x.u)}" target="_blank" rel="noopener">Réserver</a>` : ''}
        ${t ? `<a class="btn ghost small" href="${esc(lienCarte(t))}" target="_blank" rel="noopener">Y aller</a>` : ''}
        <a class="btn ghost small" href="/api/agenda.ics?${esc(agenda.toString())}" target="_blank" rel="noopener">Agenda</a>
        ${navigator.share ? `<button class="btn ghost small" data-cart-share="${esc(cartKey(x))}">Partager</button>` : ''}
      </div>`}
    </div>
    <button class="fav" data-cart-del="${esc(cartKey(x))}" title="Retirer" aria-label="Retirer">✕</button>
  </div>`;
}

function renderCart() {
  const n = state.cart.length;
  const passees = state.cart.filter(cartPassee);
  const aVenir = n - passees.length;
  $('#cartCount').textContent = aVenir;
  $('#cartFab').hidden = n === 0;
  $('#tabCart').textContent = aVenir;
  $('#tabCart').hidden = !aVenir;
  $('#cartClear').hidden = n === 0;

  const jours = new Set(state.cart.filter((x) => !cartPassee(x)).map((x) => x.d)).size;
  $('#cartSummary').textContent = aVenir ? `${plural(aVenir, 'séance')} · ${plural(jours, 'jour')}` : '';

  const parJour = new Map();
  for (const x of cartSorted()) {
    if (cartPassee(x)) continue;
    if (!parJour.has(x.d)) parJour.set(x.d, []);
    parJour.get(x.d).push(x);
  }

  const venir = [...parJour.entries()].map(([date, items]) => {
    const [label, num] = fmtDate(date);
    return `<div class="cart-day">
      <button class="cart-date" data-cart-date="${date}">${esc(label)} ${esc(num)}</button>
      ${items.map((x, i) => cartItemHTML(x) + (items[i + 1] ? entreDeux(x, items[i + 1]) : '')).join('')}
    </div>`;
  }).join('');

  // Les séances passées ne se perdent pas en silence, mais ne gênent plus.
  const anciennes = passees.length
    ? `<div class="cart-day cart-old">
        <div class="cart-date cart-old-head">Passées <button class="linklike" id="cartPurge">Les retirer</button></div>
        ${cartSorted().filter(cartPassee).reverse().map(cartItemHTML).join('')}
      </div>`
    : '';

  $('#cartBody').innerHTML = (venir + anciennes) || `<div class="empty cart-empty">
    <h2>Aucune séance gardée</h2>
    <p>Touche un horaire pour le garder ici. Tes séances suivent sur ton PC et ton iPhone.</p>
  </div>`;
}

/* ---------------------------------------------------------- petit message */

let toastTimer;
let toastAnnuler = null;
function toast(texte, annuler = null) {
  clearTimeout(toastTimer);
  toastAnnuler = annuler;
  $('#toastText').textContent = texte;
  $('#toastUndo').hidden = !annuler;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3500);
}

/* ------------------------------------------------------------- watchlist */

/** Analyseur CSV minimal, tolérant aux guillemets et aux virgules dans les titres. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Lit un export Letterboxd (watchlist.csv : Date, Name, Year, Letterboxd URI).
 * On ne garde que le titre et l'année — c'est ce qui sert à reconnaître le film.
 */
function parseWatchlist(text) {
  const rows = parseCsv(text.replace(/^﻿/, '').trim());
  if (!rows.length) return [];
  const head = rows.shift().map((h) => h.trim().toLowerCase());
  const iName = head.findIndex((h) => h === 'name' || h === 'title');
  const iYear = head.findIndex((h) => h === 'year');
  if (iName < 0) return [];

  const out = [];
  for (const r of rows) {
    const title = (r[iName] || '').trim();
    if (!title) continue;
    const year = Number(r[iYear]) || null;
    out.push({ title, year });
  }
  return out;
}

/**
 * Associe les films de la journée à la watchlist. Letterboxd donne le titre
 * original, AlloCiné donne surtout le titre français : on compare les deux, et
 * on tolère un an d'écart (année de production vs année de sortie française).
 */
function watchlistMatches(day) {
  const hit = new Set();
  if (!day) return hit;

  // Ce que tu as ajouté toi-même dans l'app, entre deux exports Letterboxd.
  for (const id of state.wlLocal) if (day.movies[id]) hit.add(Number(id));

  const wl = [...(state.watchlist || []), ...state.wlPerso];
  if (!wl.length) return hit;

  // Identifiant Letterboxd connu des deux côtés : correspondance sûre, même
  // quand le titre français n'a rien à voir (« Les Sept Samouraïs » / seven-samurai).
  const slugs = new Set(wl.map((x) => x.slug).filter(Boolean));
  if (slugs.size) {
    for (const m of Object.values(day.movies)) {
      const r = state.ratings[m.id];
      const slug = r?.slug || r?.wd;
      if (slug && slugs.has(slug)) hit.add(m.id);
    }
  }

  const index = new Map(); // titre normalisé -> années
  for (const item of wl) {
    const k = norm(item.title);
    if (!k) continue;
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(item.year);
  }

  for (const m of Object.values(day.movies)) {
    for (const candidat of [m.title, m.originalTitle]) {
      const annees = candidat ? index.get(norm(candidat)) : null;
      if (!annees) continue;
      const ok = annees.some((y) => !y || !m.year || Math.abs(y - m.year) <= 1);
      if (ok) { hit.add(m.id); break; }
    }
  }
  return hit;
}

/** Nombre de jours depuis l'import du CSV, ou null. */
function watchlistAgeDays() {
  if (!state.wlImportedAt) return null;
  return Math.floor((Date.now() - Date.parse(state.wlImportedAt)) / 86400000);
}

/* -------------------------------------------------------------- distance */

function haversine(aLat, aLon, bLat, bLon) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Distance en km depuis le point de départ choisi, ou null s'il n'y en a pas. */
function distanceTo(theater) {
  const o = state.origin;
  if (!o || !Number.isFinite(theater?.lat)) return null;
  return haversine(o.lat, o.lon, theater.lat, theater.lon);
}

const fmtKm = (km) => (km == null ? '' : km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1).replace('.', ',')} km`);
// AlloCine sert des vignettes redimensionnees : inutile de tirer l'affiche pleine taille.
const thumb = (url) => (url ? url.replace('.net/img/', '.net/r_200_300/img/') : null);
// Date et heure de PARIS (format suédois = AAAA-MM-JJ), où que soit le téléphone :
// les séances sont à l'heure de Paris, même consultées depuis l'étranger.
const HEURE_PARIS = { timeZone: 'Europe/Paris' };
const todayStr = () => new Date().toLocaleDateString('sv', HEURE_PARIS);
const nowHHMM = () => new Date().toLocaleTimeString('sv', { ...HEURE_PARIS, hour: '2-digit', minute: '2-digit' });
function demainStr() {
  const d = new Date(todayStr() + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('sv');
}

function fmtDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  const day = d.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '');
  const num = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }).replace('.', '');
  if (iso === todayStr()) return ["aujourd'hui", num];
  if (iso === demainStr()) return ['demain', num];
  return [day, num];
}
const fmtRuntime = (min) => (min ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}` : '');

/**
 * Note d'un film : Letterboxd en priorité, AlloCiné en repli. Les deux sont sur
 * 5, donc directement comparables. `source` sert à ne pas faire passer une note
 * pour l'autre dans l'infobulle.
 */
function noteFilm(m) {
  const lb = state.ratings[m.id];
  if (lb?.note != null) {
    return { valeur: lb.note, source: 'Letterboxd', votes: lb.votes, url: `https://letterboxd.com/film/${lb.slug}/` };
  }
  if (m.userRating != null) return { valeur: m.userRating, source: 'AlloCiné', votes: null, url: null };
  return null;
}

/* ------------------------------------------------------------------ data */

async function getJSON(url) {
  // Serveur en train de redémarrer, fichier en cours d'écriture : null plutôt qu'une exception.
  // Une requête gelée par la mise en veille de l'iPhone finit aussi par rendre la main.
  const arret = new AbortController();
  const minuterie = setTimeout(() => arret.abort(), 25000);
  try {
    const res = await fetch(url, { signal: arret.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(minuterie);
  }
}

async function boot() {
  state.index = await getJSON('/api/index');
  const theaters = await getJSON('/api/theaters');
  state.ratings = (await getJSON('/api/ratings')) || {};
  state.lbStatus = await getJSON('/api/watchlist/status');
  if (!state.index || !theaters) return waitForFirstData();
  watchRefresh(); // suppose un index déjà chargé

  state.theaters = theaters.theaters;
  state.byId = new Map(state.theaters.map((t) => [t.id, t]));

  renderDates();
  buildStaticFilters();
  const first = state.index.days.find((d) => d.date === todayStr()) || state.index.days[0];
  await selectDate(first.date);
  await passerSiJourneeFinie();

  // Un export Letterboxd frais dans Téléchargements ? On le reprend sans rien demander.
  if (lireWatchlistDansAdresse()) {
    state.wlHits = watchlistMatches(state.day);
    renderWatchlist();
    render();
    setStatus('ok', `Watchlist reçue depuis Letterboxd — ${plural(state.watchlist.length, 'film')}, ${state.wlHits.size} à l'affiche`, { autoHide: 8000 });
  }

  // Toutes les journées en copie hors ligne, sans retarder l'affichage.
  setTimeout(() => prechargerJours().catch(() => {}), 1500);

  recupererWatchlistPoussee()
    .then((recue) => (recue ? null : detecterExportLetterboxd()))
    .then(() => rappelerWatchlist())
    .catch(() => {});
}

/** Plus aucune séance à venir aujourd'hui (tard le soir) : on ouvre le jour suivant. */
async function passerSiJourneeFinie() {
  if (state.date !== todayStr() || !state.filters.hidePast || !state.day) return;
  const now = slot(nowHHMM());
  const reste = state.day.shows.some((s) => slot(s.s) >= now && (!state.filters.ugcOnly || state.byId.get(s.t)?.ugc));
  if (reste) return;
  const suivant = state.index.days.find((d) => d.date > state.date);
  if (suivant) await selectDate(suivant.date);
}

const dayCache = new Map();
async function loadDay(date) {
  if (dayCache.has(date)) return dayCache.get(date);
  const day = await getJSON(`/api/day/${date}`);
  // Un échec passager ne doit pas rester en cache : on réessaiera au prochain clic.
  if (day) dayCache.set(date, day);
  return day;
}

async function selectDate(date) {
  // Autre jour : on revient en haut de la liste, sinon on atterrit au milieu.
  if (state.date && date !== state.date && state.filmOpen == null) scrollTo(0, 0);
  state.date = date;
  state.limit = PAGE;
  state.expanded = new Set();
  state.search = null;
  state.day = await loadDay(date);
  state.wlHits = watchlistMatches(state.day);
  renderDates();
  buildGenres();
  renderWatchlist();

  if (!state.day) {
    $('#count').textContent = '';
    $('#results').innerHTML = `<div class="empty"><h2>Journée pas encore récupérée</h2>
      <p>Lance <strong>Mettre à jour</strong> pour télécharger les séances de cette date.</p></div>`;
    return;
  }
  render();
}

/* --------------------------------------------------------------- filtres */

/** Jour encore creux : la plupart des salles n'ont pas encore publié leur programme. */
function isSparse(date) {
  const days = state.index?.days || [];
  const max = Math.max(0, ...days.map((d) => d.shows || 0));
  const d = days.find((x) => x.date === date);
  return Boolean(d && max && (d.shows || 0) < 0.4 * max);
}

function sparseNotice() {
  if (!isSparse(state.date)) return '';
  return `<p class="notice">Programme pas encore complet pour ce jour : les cinémas publient la semaine suivante
    en général le lundi ou le mardi. L'app revérifie toute seule toutes les 2 h tant qu'elle est ouverte.</p>`;
}

/** Salles interrogées chaque jour mais qui ne publient aucun horaire en ligne. */
function silentTheaters() {
  return (state.index?.silent || []).map((id) => state.byId.get(id)).filter(Boolean);
}

function renderDates() {
  $('#dates').innerHTML = state.index.days.map((d) => {
    const [label, num] = fmtDate(d.date);
    const partial = d.complete === false;
    const sparse = !partial && isSparse(d.date);
    return `<button class="date-btn ${d.date === state.date ? 'active' : ''}${sparse ? ' sparse' : ''}" data-date="${d.date}"
      title="${d.shows ?? 0} séances${partial ? ` · ${d.theatersScanned}/${d.theatersTotal} salles récupérées` : ''}${sparse ? ' · programme pas encore publié par la plupart des salles' : ''}">
      <span>${esc(num)}${partial ? ' <i>·</i>' : ''}</span><small>${esc(label)}</small></button>`;
  }).join('');

  // Le jour choisi reste visible dans la bande, même sur un écran étroit.
  const bande = $('#dates');
  const actif = bande.querySelector('.active');
  if (actif) bande.scrollLeft = actif.offsetLeft - bande.offsetLeft - (bande.clientWidth - actif.offsetWidth) / 2;

  $('#meta').textContent = metaText();
}

function buildStaticFilters() {
  const f = state.filters;

  $('#depts').innerHTML = DEPTS.map(
    ([code, name]) => `<button class="chip ${f.depts.includes(code) ? 'active' : ''}" data-dept="${code}" title="${esc(name)}">${code}</button>`,
  ).join('');

  $('#q').value = f.q;
  $('#qClear').hidden = !f.q;
  $('#from').value = f.from;
  $('#to').value = f.to;
  $('#onlyFav').checked = f.onlyFav;
  $('#hidePast').checked = f.hidePast;
  $('#hidePreview').checked = f.hidePreview;
  $('#minNote').checked = f.minNote;
  $('#sort').value = state.sort;

  for (const b of document.querySelectorAll('#versions .chip')) b.classList.toggle('active', (b.dataset.v || '') === f.version);
  for (const b of document.querySelectorAll('#slots .chip')) b.classList.toggle('active', b.dataset.from === f.from && b.dataset.to === f.to);
  for (const b of document.querySelectorAll('#view .chip')) b.classList.toggle('active', b.dataset.view === state.view);

  renderOrigin();
  renderUgc();
  renderWatchlist();
  renderPerso();
  refreshPlaceLists();
}

function renderUgc() {
  if (state.index) $('#meta').textContent = metaText();
  const total = state.theaters.length;
  const acceptes = state.theaters.filter((t) => t.ugc).length;
  $('#ugcOnly').checked = state.filters.ugcOnly;
  const muets = silentTheaters().filter((t) => !state.filters.ugcOnly || t.ugc);
  $('#ugcInfo').textContent = (state.filters.ugcOnly
    ? `${acceptes} cinémas sur ${total} acceptent la carte (UGC + partenaires).`
    : `Tous les cinémas sont affichés — ${acceptes} acceptent la carte.`)
    + (muets.length
      ? ` Sans aucun horaire publié en ligne (à appeler) : ${muets.map((t) => t.name).join(', ')}.`
      : '');
}

$('#ugcOnly').addEventListener('change', async (e) => {
  state.filters.ugcOnly = e.target.checked;
  // Le périmètre pilote aussi la récupération : inutile d'interroger AlloCiné
  // pour des salles qu'on n'affiche pas.
  fetch('/api/scope', { method: 'POST', body: JSON.stringify({ ugcOnly: e.target.checked }) }).catch(() => {});
  renderUgc();
  onFilterChange({ places: true });
});

function refreshPlaceLists() {
  const f = state.filters;
  const inScope = (t) => !f.ugcOnly || t.ugc;
  const inDept = (t) => inScope(t) && (!f.depts.length || f.depts.includes(t.dept));

  // `numeric` pour que Paris 2e vienne avant Paris 10e.
  const cities = [...new Set(state.theaters.filter(inDept).map((t) => t.city))]
    .sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));
  if (f.city && !cities.includes(f.city)) f.city = '';
  $('#city').innerHTML = `<option value="">Toutes les villes</option>` +
    cities.map((c) => `<option value="${esc(c)}" ${c === f.city ? 'selected' : ''}>${esc(c)}</option>`).join('');

  const list = state.theaters
    .filter((t) => inDept(t) && (!f.city || t.city === f.city))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  if (f.theater && !list.some((t) => t.id === f.theater)) f.theater = '';
  $('#theater').innerHTML = `<option value="">Tous les cinémas (${list.length})</option>` +
    list.map((t) => `<option value="${t.id}" ${t.id === f.theater ? 'selected' : ''}>${esc(t.name)} — ${esc(t.city)}</option>`).join('');
}

function buildGenres() {
  const set = new Set();
  for (const m of Object.values(state.day?.movies || {})) for (const g of m.genres || []) set.add(g);
  const genres = [...set].sort((a, b) => a.localeCompare(b, 'fr'));
  if (state.filters.genre && !genres.includes(state.filters.genre)) state.filters.genre = '';
  $('#genre').innerHTML = `<option value="">Tous les genres</option>` +
    genres.map((g) => `<option value="${esc(g)}" ${g === state.filters.genre ? 'selected' : ''}>${esc(g)}</option>`).join('');
}

function filteredShows() {
  if (!state.day) return [];
  const f = state.filters;
  const movies = state.day.movies;
  const isToday = state.date === todayStr();
  const nowSlot = slot(nowHHMM());
  const idx = searchIndex();

  return state.day.shows.filter((s) => {
    const t = state.byId.get(s.t);
    if (!t) return false;
    if (f.depts.length && !f.depts.includes(t.dept)) return false;
    if (f.city && t.city !== f.city) return false;
    if (f.theater && s.t !== f.theater) return false;
    if (f.onlyFav && !state.favs.has(s.t)) return false;
    if (f.ugcOnly && !t.ugc) return false;
    if (f.radius && state.origin) {
      const km = distanceTo(t);
      if (km == null || km > Number(f.radius)) return false;
    }
    if (f.version === 'VO' && s.v === 'VF') return false;
    if (f.version === 'VF' && s.v !== 'VF') return false;
    if (f.from && s.s < f.from) return false;
    if (f.to && s.s > f.to) return false;
    if (f.onlyWatchlist && !state.wlHits.has(s.m)) return false;
    if (f.hidePreview && s.p) return false;
    if (f.hidePast && isToday && slot(s.s) < nowSlot) return false;

    const m = movies[s.m];
    if (!m) return false;
    if (f.genre && !(m.genres || []).includes(f.genre)) return false;
    if (f.minNote && (noteFilm(m)?.valeur ?? 0) < 3.5) return false;

    // Les mots de la requête peuvent se répartir entre le film et le cinéma
    // ("chungking pantheon") : on exige seulement que tous soient couverts.
    if (idx.tokens.length) {
      const mask = (idx.movies.get(s.m) || 0) | (idx.theaters.get(s.t) || 0);
      if (mask !== idx.full) return false;
    }
    return true;
  });
}

/* ------------------------------------------------------------------- vue */

function groupBy(shows, keyFn, subFn) {
  const out = new Map();
  for (const s of shows) {
    const k = keyFn(s);
    let sub = out.get(k);
    if (!sub) out.set(k, (sub = new Map()));
    const k2 = subFn(s);
    let arr = sub.get(k2);
    if (!arr) sub.set(k2, (arr = []));
    arr.push(s);
  }
  return out;
}

/** "dans 9 min", "dans 1 h 20" — pour situer une séance sans faire le calcul. */
function fmtIn(mins) {
  if (mins <= 0) return 'maintenant';
  if (mins < 60) return `dans ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `dans ${h} h ${String(m).padStart(2, '0')}` : `dans ${h} h`;
}

/** Info-bulle d'une pastille horaire. Partagée avec syncChips et le clic pour ne pas perdre la mention AP. */
function chipTitle(kept, preview, unconfirmed) {
  return (kept ? 'Retirer de mes séances' : 'Garder cette séance')
    + (preview ? ' · AP = avant-première (projection avant la sortie officielle)' : '')
    + (unconfirmed ? ' · ? = AlloCiné ne liste plus ce cinéma pour le moment : séance connue avant, à vérifier sur la billetterie' : '');
}

/** Un ticket : l'heure et la version. Un clic met la séance de côté. */
function ticketHTML(s, badge = '') {
  const isToday = state.date === todayStr();
  const mins = slot(s.s) - slot(nowHHMM());
  const past = isToday && mins < 0;
  const soon = isToday && !past && mins <= 120;
  const kept = cartHas(state.date, s);
  const cls = `time${past ? ' past' : ''}${s.p ? ' preview' : ''}${s.x ? ' unconfirmed' : ''}${soon ? ' soon' : ''}${kept ? ' kept' : ''}`;
  return `<button class="${cls}" data-show="${esc(JSON.stringify({ t: s.t, m: s.m, s: s.s, v: s.v, u: s.u }))}"
    title="${chipTitle(kept, s.p, s.x)}">${s.s} <em>${s.v}${s.p ? ' · AP' : ''}${s.x ? ' ?' : ''}</em>${badge}</button>`;
}

function timesHTML(shows) {
  const isToday = state.date === todayStr();
  const nowMin = slot(nowHHMM());
  const sorted = shows.slice().sort((a, b) => slot(a.s) - slot(b.s));
  // La première séance encore à venir de cette salle : c'est celle qu'on annote.
  const nextIndex = isToday ? sorted.findIndex((s) => slot(s.s) >= nowMin) : -1;

  return sorted
    .map((s, i) => {
      const mins = slot(s.s) - nowMin;
      return ticketHTML(s, i === nextIndex && mins <= 240 ? `<i class="in">${fmtIn(mins)}</i>` : '');
    })
    .join('');
}

const momentDe = (min) => (min < 360 ? 'Nuit' : min < 780 ? 'Matin' : min < 1080 ? 'Après-midi' : 'Soirée');

/**
 * Les séances une par une, de la plus tôt à la plus tard, par moment de la
 * journée : ce qu'on veut savoir d'abord, c'est « à quelle heure je peux y aller ».
 */
function sheetTimeline(shows, kind) {
  const isToday = state.date === todayStr();
  const nowMin = slot(nowHHMM());
  const nom = (s) => (kind === 'film' ? state.byId.get(s.t)?.name : state.day.movies[s.m]?.title) || '';
  const sorted = shows.slice().sort((a, b) => slot(a.s) - slot(b.s) || nom(a).localeCompare(nom(b), 'fr'));
  const prochaine = isToday ? sorted.find((s) => slot(s.s) >= nowMin) : null;
  let moment = null;
  return `<div class="sheet-timeline">${sorted.map((s) => {
    const m = momentDe(slot(s.s));
    const titre = m !== moment ? `<h4 class="tl-moment">${m}</h4>` : '';
    moment = m;
    const dans = s === prochaine && slot(s.s) - nowMin <= 240 ? `<b>${fmtIn(slot(s.s) - nowMin)}</b>` : '';
    let quoi;
    if (kind === 'film') {
      const t = state.byId.get(s.t);
      const lieu = [t?.city, state.origin ? fmtKm(distanceTo(t)) : ''].filter(Boolean).map(esc).join(' · ');
      quoi = `<button class="linklike tl-name" data-cine="${esc(s.t)}">${state.favs.has(s.t) ? '<i class="tl-fav" title="Dans mes cinémas">★</i> ' : ''}${esc(t?.name)}</button>
        <span class="tl-sub">${dans}${dans && lieu ? ' · ' : ''}${lieu}</span>`;
    } else {
      const f = state.day.movies[s.m];
      const infos = [fmtRuntime(f?.runtime), (f?.genres || [])[0]].filter(Boolean).map(esc).join(' · ');
      quoi = `<button class="linklike tl-name" data-film="${s.m}">${esc(f?.title)}</button>
        <span class="tl-sub">${dans}${dans && infos ? ' · ' : ''}${infos}</span>`;
    }
    return `${titre}<div class="tl-row">
      ${ticketHTML(s)}
      <div class="tl-what">${quoi}</div>
      ${s.u ? `<a class="tl-book" href="${esc(s.u)}" target="_blank" rel="noopener">Réserver</a>` : ''}
    </div>`;
  }).join('')}</div>`;
}

/** L'interrupteur du panneau : les séances par heure ou par salle. */
function sheetModeHTML(kind) {
  const autre = kind === 'film' ? 'Par cinéma' : 'Par film';
  return `<div class="segmented sheet-mode" role="group" aria-label="Ordre des séances">
    <button class="chip${state.sheetMode === 'heure' ? ' active' : ''}" data-sheet-mode="heure">Par heure</button>
    <button class="chip${state.sheetMode === 'salle' ? ' active' : ''}" data-sheet-mode="salle">${autre}</button>
  </div>`;
}

/**
 * Ajout / retrait d'un film à la liste « à voir », sans passer par Letterboxd.
 * Un film venu du CSV ne peut pas être retiré ici : il faut le faire sur
 * Letterboxd puis réimporter, sinon les deux listes divergeraient en silence.
 */
function wlToggle(m) {
  const local = state.wlLocal.has(String(m.id));
  const importe = state.wlHits.has(m.id) && !local;
  if (importe) return '';
  return `<button class="wl-toggle ${local ? 'on' : ''}" data-wl="${m.id}"
    title="${local ? 'Retirer de ma liste à voir' : 'Ajouter à ma liste à voir'}">${local ? '✓' : '+'}</button>`;
}

function favBtn(id) {
  const on = state.favs.has(id);
  return `<button class="fav ${on ? 'on' : ''}" data-fav="${id}" title="${on ? 'Retirer de mes cinémas' : 'Ajouter à mes cinémas'}">${on ? '★' : '☆'}</button>`;
}

function movieCard(m, theaterMap, total, { full = false, jours = '' } = {}) {
  const rows = [...theaterMap.entries()]
    .map(([tid, shows]) => ({ t: state.byId.get(tid), shows }))
    .filter((r) => r.t)
    .sort((a, b) => {
      const fa = state.favs.has(a.t.id) ? 0 : 1, fb = state.favs.has(b.t.id) ? 0 : 1;
      if (fa !== fb) return fa - fb;
      // Cohérence avec le tri choisi : si tu cherches ce qui commence le plus
      // tôt, la salle qui projette le plus tôt doit être en tête de la carte.
      // Sinon : par distance si un point de départ est donné, et par défaut
      // par prochaine séance — plus utile que l'ordre alphabétique.
      const soonest = (r) => nextSlot(r.shows);
      if (state.origin && state.sort !== 'next') return (distanceTo(a.t) ?? 1e9) - (distanceTo(b.t) ?? 1e9);
      const d = soonest(a) - soonest(b);
      return (Number.isNaN(d) ? 0 : d) || a.t.name.localeCompare(b.t.name, 'fr');
    });

  const key = `m${m.id}`;
  const open = state.expanded?.has(key);
  const shown = open || full ? rows : rows.slice(0, 6);

  const note = noteFilm(m);
  // La note Letterboxd ouvre la fiche du film sur Letterboxd (pour le noter ou
  // l'ajouter à la watchlist d'un clic).
  const noteTag = note?.url ? 'a' : 'span';
  const noteHtml = note
    ? `<${noteTag} class="rating ${note.source === 'Letterboxd' ? 'lb' : 'ac'}"
         ${note.url ? `href="${esc(note.url)}" target="_blank" rel="noopener"` : ''}
         title="${note.source}${note.votes ? ` — ${note.votes.toLocaleString('fr-FR')} votes` : ''}${note.url ? ' · ouvrir sur Letterboxd' : ''}"
       >★ ${note.valeur.toFixed(1).replace('.', ',')}<i>${note.source === 'Letterboxd' ? 'LB' : 'AC'}</i></${noteTag}>`
    : '';

  const meta = [
    fmtRuntime(m.runtime),
    (m.genres || []).slice(0, 3).join(', '),
    m.year,
    noteHtml,
    m.pressRating ? `presse ${m.pressRating.toFixed(1).replace('.', ',')}` : '',
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join('');

  const people = [
    m.directors?.length ? `De ${esc(m.directors.join(', '))}` : '',
    m.cast?.length ? `avec ${esc(m.cast.join(', '))}` : '',
  ].filter(Boolean).join('<span class="dot">·</span>');

  // L'affiche, floutée, teinte le fond de la fiche (adresse vérifiée avant
  // d'entrer dans le CSS : seulement une URL https sans caractère spécial).
  const vignette = thumb(m.poster);
  const ambiance = vignette && /^https:\/\/[^\s"'()\\]+$/.test(vignette) ? ` style="--poster:url('${vignette}')"` : '';
  return `<article class="card film"${ambiance}>
    ${m.poster ? `<img class="poster" loading="lazy" referrerpolicy="no-referrer" src="${esc(vignette)}" alt="">` : `<div class="poster"></div>`}
    <div class="card-body">
      <h3 class="card-title">
        ${wlToggle(m)}
        ${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a>` : esc(m.title)}
        ${state.wlHits.has(m.id) ? `<span class="wl-badge" title="Dans ta liste à voir">à voir</span>` : ''}
        <span class="group-sub">${plural(total, 'séance')} · ${plural(rows.length, 'cinéma')}</span>
      </h3>
      <div class="card-meta">${meta}</div>
      ${people ? `<div class="card-people">${people}</div>` : ''}
      ${full && m.synopsis ? `<p class="card-synopsis">${esc(m.synopsis)}</p>` : ''}
      ${full ? `<div class="card-links">${m.url ? `<a class="btn ghost small" href="${esc(m.url)}" target="_blank" rel="noopener">Fiche AlloCiné</a>` : ''}<a class="btn ghost small" href="${esc(note?.url || `https://letterboxd.com/search/films/${encodeURIComponent(m.originalTitle || m.title)}/`)}" target="_blank" rel="noopener">Letterboxd</a><a class="btn ghost small" href="https://www.youtube.com/results?search_query=${esc(encodeURIComponent(`${m.title} ${m.year || ''} bande annonce`))}" target="_blank" rel="noopener">Bande-annonce</a></div>` : ''}
      ${full ? jours + sheetModeHTML('film') : ''}
      ${full && state.sheetMode === 'heure' ? sheetTimeline(rows.flatMap((r) => r.shows), 'film') : shown.map((r) => `<div class="group">
        <div class="group-head">
          ${favBtn(r.t.id)}
          ${full ? `<button class="group-name linklike" data-cine="${esc(r.t.id)}" title="Voir tout le programme de ce cinéma">${esc(r.t.name)}</button>` : `<span class="group-name">${esc(r.t.name)}</span>`}
          <span class="group-sub">${esc(r.t.city)}${state.origin ? ` · ${fmtKm(distanceTo(r.t))}` : ''}</span>
        </div>
        <div class="times">${timesHTML(r.shows)}</div>
      </div>`).join('')}
      ${!full && rows.length > 6 ? `<button class="more" data-expand="${key}">${open ? '− Réduire' : `+ ${rows.length - 6} autres cinémas`}</button>` : ''}
    </div>
  </article>`;
}

function theaterCard(t, movieMap, total, { full = false, jours = '' } = {}) {
  const rows = [...movieMap.entries()]
    .map(([mid, shows]) => ({ m: state.day.movies[mid], shows }))
    .filter((r) => r.m)
    .sort((a, b) => {
      // Dans le panneau (ou avec le tri « prochaine séance ») : ce qui commence
      // le plus tôt d'abord. Sinon, les films les plus programmés.
      if (full || state.sort === 'next') {
        const d = nextSlot(a.shows) - nextSlot(b.shows);
        return (Number.isNaN(d) ? 0 : d) || a.m.title.localeCompare(b.m.title, 'fr');
      }
      return b.shows.length - a.shows.length || a.m.title.localeCompare(b.m.title, 'fr');
    });

  const key = `t${t.id}`;
  const open = state.expanded?.has(key);
  const shown = open || full ? rows : rows.slice(0, 8);
  const itineraire = lienCarte(t);

  return `<article class="card cine">
    <div class="card-body">
      <h3 class="card-title">
        ${favBtn(t.id)}
        <a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.name)}</a>
        <span class="group-sub">${plural(total, 'séance')} · ${plural(rows.length, 'film')}</span>
      </h3>
      <div class="card-meta"><span>${esc(t.address)}</span>${state.origin ? `<span>${fmtKm(distanceTo(t))}</span>` : ''}</div>
      ${full ? `<div class="card-links"><a class="btn small" href="${esc(itineraire)}" target="_blank" rel="noopener">Itinéraire</a><a class="btn ghost small" href="${esc(t.url)}" target="_blank" rel="noopener">Page AlloCiné</a></div>` : ''}
      ${full ? jours + sheetModeHTML('theater') : ''}
      ${full && state.sheetMode === 'heure' ? sheetTimeline(rows.flatMap((r) => r.shows), 'theater') : shown.map((r) => `<div class="group">
        <div class="group-head">
          ${full ? `<button class="group-name linklike" data-film="${r.m.id}" title="Voir ce film partout">${esc(r.m.title)}</button>` : `<span class="group-name">${esc(r.m.title)}</span>`}
          <span class="group-sub">${[fmtRuntime(r.m.runtime), (r.m.genres || [])[0], noteFilm(r.m) ? `★ ${noteFilm(r.m).valeur.toFixed(1).replace('.', ',')}` : ''].filter(Boolean).join(' · ')}</span>
        </div>
        <div class="times">${timesHTML(r.shows)}</div>
      </div>`).join('')}
      ${!full && rows.length > 8 ? `<button class="more" data-expand="${key}">${open ? '− Réduire' : `+ ${rows.length - 8} autres films`}</button>` : ''}
    </div>
  </article>`;
}

/**
 * Heure de la prochaine séance, pour le tri « prochaine séance ». Aujourd'hui,
 * les séances déjà commencées ne comptent pas (elles restent visibles si
 * « Masquer les séances passées » est décoché) ; un groupe sans plus rien à venir
 * part en fin de liste.
 */
function nextSlot(shows) {
  const now = state.date === todayStr() ? slot(nowHHMM()) : -1;
  let best = Infinity;
  for (const s of shows) {
    const t = slot(s.s);
    if (t >= now && t < best) best = t;
  }
  return best;
}

function sortEntries(entries, kind) {
  const sort = state.sort;
  const total = (sub) => [...sub.values()].reduce((n, a) => n + a.length, 0);
  const firstTime = (sub) => nextSlot([...sub.values()].flat());
  // Pour un film : distance du cinéma le plus proche qui le programme.
  const nearest = (sub) => [...sub.keys()].reduce((min, tid) => {
    const km = distanceTo(state.byId.get(tid));
    return km == null ? min : Math.min(min, km);
  }, Infinity);

  return entries.sort(([ka, sa], [kb, sb]) => {
    if (kind === 'films') {
      const A = state.day.movies[ka], B = state.day.movies[kb];
      switch (sort) {
        case 'alpha': return A.title.localeCompare(B.title, 'fr');
        case 'rating': return (noteFilm(B)?.valeur || 0) - (noteFilm(A)?.valeur || 0);
        case 'press': return (B.pressRating || 0) - (A.pressRating || 0);
        case 'recent': return String(B.releaseDate || '').localeCompare(String(A.releaseDate || ''));
        case 'next': return firstTime(sa) - firstTime(sb);
        case 'near': return state.origin ? nearest(sa) - nearest(sb) : total(sb) - total(sa);
        default: return total(sb) - total(sa) || A.title.localeCompare(B.title, 'fr');
      }
    }
    const A = state.byId.get(ka), B = state.byId.get(kb);
    const fa = state.favs.has(ka) ? 0 : 1, fb = state.favs.has(kb) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    switch (sort) {
      case 'popular': return total(sb) - total(sa);
      case 'next': return firstTime(sa) - firstTime(sb);
      case 'near': return state.origin ? (distanceTo(A) ?? 1e9) - (distanceTo(B) ?? 1e9) : A.name.localeCompare(B.name, 'fr');
      default: return A.name.localeCompare(B.name, 'fr');
    }
  });
}

/**
 * L'affiche du jour, en tête des résultats : la date en lettres d'enseigne,
 * ce qu'il y a à voir, et l'heure de la prochaine séance. Le fond reprend
 * l'affiche floutée du premier film de la liste.
 */
function renderHero(shows, entries) {
  const d = new Date(state.date + 'T12:00:00');
  const isToday = state.date === todayStr();
  const estDemain = state.date === demainStr();
  const jour = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const tard = isToday && slot(nowHHMM()) >= 17 * 60;
  $('#dayTitle').textContent = isToday ? (tard ? 'Ce soir' : "Aujourd'hui") : estDemain ? 'Demain' : jour.charAt(0).toUpperCase() + jour.slice(1);
  $('#dayKicker').textContent = isToday || estDemain ? jour : '';
  $('#dayKicker').hidden = !isToday && !estDemain;

  const films = new Set(shows.map((s) => s.m)).size;
  const salles = new Set(shows.map((s) => s.t)).size;
  const parts = shows.length
    ? [`${plural(shows.length, 'séance')}`, `${plural(films, 'film')}`, `${plural(salles, 'cinéma')}`]
    : [];
  const prochaine = isToday ? nextSlot(shows) : Infinity;
  if (Number.isFinite(prochaine)) {
    const hh = String(Math.floor(prochaine / 60)).padStart(2, '0');
    const mm = String(prochaine % 60).padStart(2, '0');
    parts.push(`prochaine à ${hh}h${mm}`);
  }
  // Espaces insécables dans chaque info : « prochaine à 21h00 » ne se coupe pas.
  $('#daySub').textContent = parts.map((p) => p.replace(/ /g, '\u00a0')).join('   ');

  // Fond : l'affiche du premier film affiché (vue par film) ou du film le plus
  // programmé de la journée (vue par cinéma).
  let mid = state.view === 'films' ? entries[0]?.[0] : null;
  if (mid == null && shows.length) {
    const n = new Map();
    for (const s of shows) n.set(s.m, (n.get(s.m) || 0) + 1);
    mid = [...n.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  const url = thumb(state.day?.movies[mid]?.poster);
  const hero = $('#dayHero');
  if (url && /^https:\/\/[^\s"'()\\]+$/.test(url)) hero.style.setProperty('--poster', `url('${url}')`);
  else hero.style.removeProperty('--poster');
}

/** Heure lisible « 21h00 » depuis des minutes depuis minuit. */
const fmtSlot = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}h${String(min % 60).padStart(2, '0')}`;

/**
 * Une tuile de film : l'affiche, le titre, la note et l'essentiel (prochaine
 * séance, nombre de cinémas). Les horaires s'ouvrent au clic, dans le panneau.
 */
function filmTile(m, theaterMap, total) {
  const flat = [...theaterMap.values()].flat();
  const premiere = state.date === todayStr() ? nextSlot(flat) : Math.min(...flat.map((x) => slot(x.s)));
  const note = noteFilm(m);
  const vignette = thumb(m.poster);
  const vu = state.wlHits.has(m.id);
  // Sur téléphone, le petit texte est coupé pour tenir sous l'affiche (.ti-long).
  const infos = [
    Number.isFinite(premiere) ? `<span class="ti-long">${state.date === todayStr() ? 'prochaine à ' : 'dès '}</span>${fmtSlot(premiere)}` : '',
    `${theaterMap.size}<span class="ti-long"> cinéma${theaterMap.size > 1 ? 's' : ''}</span><span class="ti-short"> salle${theaterMap.size > 1 ? 's' : ''}</span>`,
  ].filter(Boolean).join(' · ');
  return `<button class="film-tile" data-film="${m.id}" title="Voir les cinémas et les horaires">
    <span class="tile-poster">
      ${vignette ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(vignette)}" alt="">` : `<span class="tile-noposter">${esc(m.title)}</span>`}
      ${vu ? '<span class="tile-badge">à voir</span>' : ''}
      ${note ? `<span class="tile-note ${note.source === 'Letterboxd' ? 'lb' : 'ac'}">★ ${note.valeur.toFixed(1).replace('.', ',')}</span>` : ''}
    </span>
    <span class="tile-title">${esc(m.title)}</span>
    <span class="tile-info">${infos}</span>
  </button>`;
}

/**
 * Une ligne de la vue « par heure » : toutes les séances du jour, de la
 * prochaine à la dernière. Le ticket garde la séance, le reste ouvre le film.
 */
function heureRow(s) {
  const m = state.day.movies[s.m];
  const t = state.byId.get(s.t);
  const vignette = thumb(m?.poster);
  const lieu = [t?.name, t?.city, state.origin ? fmtKm(distanceTo(t)) : ''].filter(Boolean).join(' · ');
  return `<div class="hr-row" data-film="${s.m}">
    <span class="hr-poster">${vignette ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(vignette)}" alt="">` : ''}</span>
    <span class="hr-what">
      <span class="hr-title">${esc(m?.title)}${state.wlHits.has(s.m) ? ' <i class="hr-avoir">à voir</i>' : ''}</span>
      <span class="hr-where">${esc(lieu)}</span>
    </span>
    ${ticketHTML(s)}
  </div>`;
}

/**
 * Une tuile de cinéma : un bandeau des affiches qu'il passe, son nom, et
 * l'essentiel (ville, distance, nombre de films, prochaine séance).
 */
function theaterTile(t, movieMap, total) {
  const rows = [...movieMap.entries()]
    .map(([mid, shows]) => ({ m: state.day.movies[mid], n: shows.length }))
    .filter((r) => r.m)
    .sort((a, b) => b.n - a.n);
  const affiches = rows.map((r) => thumb(r.m.poster)).filter(Boolean).slice(0, 4);
  const flat = [...movieMap.values()].flat();
  const premiere = state.date === todayStr() ? nextSlot(flat) : Math.min(...flat.map((x) => slot(x.s)));
  const lieu = [t.city, state.origin ? fmtKm(distanceTo(t)) : ''].filter(Boolean).join(' · ');
  const infos = [
    plural(rows.length, 'film'),
    Number.isFinite(premiere) ? (state.date === todayStr() ? `prochaine à ${fmtSlot(premiere)}` : `dès ${fmtSlot(premiere)}`) : '',
  ].filter(Boolean).join(' · ');
  return `<button class="cine-tile" data-cine="${esc(t.id)}" title="Voir les films et les horaires">
    <span class="cine-posters">${affiches.map((u) => `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(u)}" alt="">`).join('')}</span>
    <span class="cine-name">${state.favs.has(t.id) ? '<i class="cine-fav" title="Dans mes cinémas">★</i>' : ''}${esc(t.name)}</span>
    <span class="tile-info">${esc(lieu)}</span>
    <span class="tile-info">${esc(infos)}</span>
  </button>`;
}

/**
 * Écrans par-dessus la liste (fiche d'un film ou d'un cinéma, mes séances,
 * filtres). Chacun ouvert ajoute une étape à l'historique : le geste « retour »
 * de l'iPhone et le bouton retour d'Android ferment l'écran au lieu de quitter
 * l'app. Une seule source : afficherUi() remet l'écran dans l'état demandé.
 */
let uiDepth = 0;
function afficherUi(sheet, panel) {
  state.filmOpen = sheet?.id ?? null;
  state.sheetKind = sheet?.kind ?? 'film';
  state.panel = panel ?? null;
  $('#filmSheet').hidden = state.filmOpen == null;
  $('#cart').hidden = state.panel !== 'cart';
  $('#filters').classList.toggle('open', state.panel === 'filters');
  document.body.classList.toggle('sheet-open', state.filmOpen != null);
  document.body.classList.toggle('panel-open', state.panel != null);
  syncTabs();
  if (state.filmOpen != null) renderFilmSheet();
  // Ouvrir ses séances, c'est vouloir la liste à jour : on synchronise tout de suite.
  if (state.panel === 'cart') setTimeout(() => { afficherSynchro(); syncPerso(); }, 0);
}
function pousserUi(sheet, panel) {
  uiDepth += 1;
  history.pushState({ ui: { sheet, panel }, depth: uiDepth }, '');
  afficherUi(sheet, panel);
}
/** Ferme tout d'un coup, quel que soit le nombre d'écrans empilés. */
function fermerUi() {
  if (uiDepth > 0) history.go(-uiDepth);
  else afficherUi(null, null);
}
addEventListener('popstate', (e) => {
  const s = e.state;
  uiDepth = s?.depth || 0;
  afficherUi(s?.ui?.sheet, s?.ui?.panel);
});
function togglePanel(panel) {
  if (state.panel === panel) return fermerUi();
  const sheet = state.filmOpen != null ? { id: state.filmOpen, kind: state.sheetKind } : null;
  pousserUi(sheet, panel);
}

/** Ouvre le panneau d'un film ou d'un cinéma (ou ferme tout avec null). */
function openFilm(id, kind = 'film') {
  if (id == null) {
    if (state.filmOpen != null || state.panel) fermerUi();
    return;
  }
  pousserUi({ id, kind }, null);
  $('#filmSheetPanel').scrollTop = 0;
  $('#filmSheetClose').focus({ preventScroll: true });
}

/** Onglet allumé en bas de l'écran, sur téléphone. */
function syncTabs() {
  const actif = state.panel || state.view;
  for (const b of document.querySelectorAll('#tabbar [data-tab]')) b.classList.toggle('active', b.dataset.tab === actif);
}

/**
 * Contenu du panneau : la fiche complète du film avec toutes ses salles, pour
 * la date et les filtres en cours. Changer de jour garde le panneau ouvert :
 * pratique pour voir le même film un autre soir.
 */
function renderFilmSheet() {
  if (state.filmOpen == null || !state.day) return;
  const id = String(state.filmOpen);
  const cine = state.sheetKind === 'theater';
  const shows = filteredShows().filter((x) => String(cine ? x.t : x.m) === id);
  const [, num] = fmtDate(state.date);
  const jours = `<nav class="sheet-days" id="sheetDays" aria-label="Autres jours"></nav>`;
  const t = cine ? state.byId.get(id) : null;
  const m = cine ? null : state.day.movies[id];
  if (!shows.length || (cine ? !t : !m)) {
    $('#filmSheetBody').innerHTML = jours + `<div class="empty"><h2>Pas de séance le ${esc(num)}</h2>
      <p>Avec les filtres actuels, ${cine ? 'ce cinéma n\'a' : 'ce film n\'a'} pas de séance ce jour-là. Choisis un autre jour ci-dessus.</p></div>`;
  } else if (cine) {
    const byMovie = groupBy(shows, (x) => x.t, (x) => x.m).get(t.id) || new Map();
    $('#filmSheetBody').innerHTML = theaterCard(t, byMovie, shows.length, { full: true, jours });
  } else {
    const byTheater = groupBy(shows, (x) => x.m, (x) => x.t).get(m.id) || new Map();
    $('#filmSheetBody').innerHTML = movieCard(m, byTheater, shows.length, { full: true, jours });
  }
  renderSheetDays(id, cine ? 'theater' : 'film');
}

/**
 * Les jours où ce film passe, avec le nombre de séances, en tête du panneau.
 * Mêmes critères de lieu et de version que la liste (pas la recherche ni
 * l'horaire, propres à la journée affichée). Un clic change de jour sans
 * fermer le panneau.
 */
let sheetDaysToken = 0;
async function renderSheetDays(id, kind = 'film') {
  const token = ++sheetDaysToken;
  const f = state.filters;
  const garde = (s) => {
    const t = state.byId.get(s.t);
    if (!t || String(kind === 'theater' ? s.t : s.m) !== id) return false;
    if (f.ugcOnly && !t.ugc) return false;
    if (f.onlyFav && !state.favs.has(s.t)) return false;
    if (f.depts.length && !f.depts.includes(t.dept)) return false;
    if (f.city && t.city !== f.city) return false;
    if (f.theater && s.t !== f.theater) return false;
    if (f.version === 'VO' && s.v === 'VF') return false;
    if (f.version === 'VF' && s.v !== 'VF') return false;
    if (f.hidePreview && s.p) return false;
    return true;
  };
  const jours = [];
  const auj = todayStr();
  const maintenant = slot(nowHHMM());
  for (const d of state.index.days) {
    const day = await loadDay(d.date);
    if (token !== sheetDaysToken) return; // panneau changé entre-temps
    // Aujourd'hui : comme la liste, sans les séances déjà commencées.
    const passee = (x) => d.date === auj && f.hidePast && slot(x.s) < maintenant;
    const n = day ? day.shows.filter((x) => garde(x) && !passee(x)).length : 0;
    if (n) jours.push({ date: d.date, n });
  }
  const box = $('#sheetDays');
  // Un seul jour, et c'est celui affiché : rien à proposer.
  if (!box || !jours.length || (jours.length === 1 && jours[0].date === state.date)) { if (box) box.hidden = true; return; }
  box.innerHTML = jours.map(({ date, n }) => {
    const [label, num] = fmtDate(date);
    return `<button class="sheet-day${date === state.date ? ' active' : ''}" data-date="${date}">
      <small>${esc(label)}</small><span>${esc(num)}</span><i>${plural(n, 'séance')}</i></button>`;
  }).join('');
  // Le jour affiché reste visible dans la bande après un changement.
  const actif = box.querySelector('.active');
  if (actif) box.scrollLeft = actif.offsetLeft - box.offsetLeft - (box.clientWidth - actif.offsetWidth) / 2;
}

/** Combien de filtres s'écartent des réglages par défaut (hors recherche). */
function filtresActifs() {
  const f = state.filters;
  return [f.from || f.to, f.version, f.genre, f.depts.length, f.city, f.theater, f.onlyFav,
    f.radius, f.onlyWatchlist, f.hidePreview, !f.ugcOnly, !f.hidePast, f.minNote].filter(Boolean).length;
}

/** Raccourcis du téléphone et pastilles de la barre du bas, en accord avec les filtres. */
function syncQuick() {
  const f = state.filters;
  const actif = {
    soir: f.from === '18:00' && f.to === '23:59',
    aprem: f.from === '13:00' && f.to === '18:00',
    vo: f.version === 'VO',
    vf: f.version === 'VF',
    proche: Boolean(state.origin),
    fav: f.onlyFav,
    avoir: f.onlyWatchlist,
    note: f.minNote,
  };
  for (const b of document.querySelectorAll('#quick [data-quick]')) b.classList.toggle('active', actif[b.dataset.quick]);
  const n = filtresActifs();
  $('#tabFilters').textContent = n;
  $('#tabFilters').hidden = !n;
  $('#sortBox').hidden = state.view === 'hours';
  $('#metaPhone').textContent = state.index ? metaText() : '';
}

/** Recherche d'un nom de cinéma : on propose la salle en plus des films qu'elle passe. */
function cinesTrouves() {
  const idx = searchIndex();
  if (!idx.tokens.length) return '';
  const liste = state.theaters
    .filter((t) => (!state.filters.ugcOnly || t.ugc) && idx.theaters.get(t.id) === idx.full)
    .slice(0, 8);
  if (!liste.length) return '';
  return `<div class="search-cines">${liste.map((t) => `<button class="chip" data-cine="${esc(t.id)}">${esc(t.name)}<i>${esc(t.city)}</i></button>`).join('')}</div>`;
}

/** La liste affichée, générée par morceaux au fil du défilement. */
let liste = { type: 'films', items: [] };
function listeHTML(from, to) {
  return liste.items.slice(from, to).map((item, i) => {
    if (liste.type === 'hours') {
      // Une ligne de titre à chaque nouvelle heure.
      const avant = liste.items[from + i - 1];
      const heure = item.s.slice(0, 2);
      const titre = !avant || avant.s.slice(0, 2) !== heure ? `<h3 class="hr-hour">${heure}h</h3>` : '';
      return titre + heureRow(item);
    }
    const [key, sub] = item;
    const total = [...sub.values()].reduce((n, a) => n + a.length, 0);
    return liste.type === 'films'
      ? filmTile(state.day.movies[key], sub, total)
      : theaterTile(state.byId.get(key), sub, total);
  }).join('');
}

const boutonPlus = () => {
  const reste = liste.items.length - state.limit;
  return reste > 0 ? `<button class="btn ghost" id="loadMore">Afficher ${Math.min(PAGE, reste)} de plus (${reste} restants)</button>` : '';
};

// Le bas de la liste approche : on ajoute la suite sans redessiner le reste.
const suiteAuto = new IntersectionObserver((vus) => {
  if (vus.some((v) => v.isIntersecting)) afficherPlus();
}, { rootMargin: '700px' });

function afficherPlus() {
  const zone = $('#liste');
  if (!zone) return;
  const avant = state.limit;
  state.limit += PAGE;
  zone.insertAdjacentHTML('beforeend', listeHTML(avant, state.limit));
  const b = $('#loadMore');
  if (b) b.outerHTML = boutonPlus();
  surveillerSuite();
}
function surveillerSuite() {
  suiteAuto.disconnect();
  const b = $('#loadMore');
  if (b) suiteAuto.observe(b);
}

function render() {
  if (!state.day) return;
  state.expanded ||= new Set();
  syncQuick();
  syncTabs();
  // Sur téléphone, la bande watchlist s'efface quand on cherche ou qu'on lit les horaires.
  document.body.classList.toggle('liste-seule', Boolean(state.filters.q.trim()) || state.view === 'hours');

  const shows = filteredShows();
  const parCinema = state.view === 'theaters';
  const grouped = parCinema
    ? groupBy(shows, (s) => s.t, (s) => s.m)
    : groupBy(shows, (s) => s.m, (s) => s.t);

  const entries = sortEntries([...grouped.entries()], parCinema ? 'theaters' : 'films');

  // Une recherche : les films dont c'est le titre passent avant ceux qui ne font
  // que correspondre par un acteur, un réalisateur ou la salle.
  const recherche = searchIndex();
  if (recherche.tokens.length && !parCinema) {
    const auTitre = ([id]) => {
      const m = state.day.movies[id];
      return tokenMask(normRecherche(`${m.title} ${m.originalTitle || ''}`), recherche.tokens) === recherche.full ? 0 : 1;
    };
    entries.sort((a, b) => auTitre(a) - auTitre(b));
  }

  $('#count').textContent = shows.length
    ? `${plural(shows.length, 'séance')} · ${plural(entries.length, parCinema ? 'cinéma' : 'film')}`
    : '';
  $('#filtersApply').textContent = shows.length ? `Voir ${plural(shows.length, 'séance')}` : 'Aucune séance avec ces filtres';
  renderHero(shows, entries);
  renderWlWeek().catch(() => {});

  if (!entries.length) {
    const [, num] = fmtDate(state.date);
    const info = state.index.days.find((d) => d.date === state.date);
    const loading = info && info.complete === false;
    const muet = state.filters.theater && silentTheaters().find((t) => t.id === state.filters.theater);
    const suivant = state.index.days.find((d) => d.date > state.date);
    const sorties = [
      suivant ? `<button class="btn small" data-date="${suivant.date}">Voir ${esc(fmtDate(suivant.date).join(' '))}</button>` : '',
      filtresActifs() ? '<button class="btn ghost small" data-reset>Réinitialiser les filtres</button>' : '',
    ].filter(Boolean).join('');
    $('#results').innerHTML = sparseNotice() + cinesTrouves() + (muet
      ? `<p class="notice">${esc(muet.name)} ne publie aucun horaire en ligne (ni sur AlloCiné, ni ailleurs) : appelle la salle pour connaître ses séances.</p>`
      : '') + `<div class="empty" id="emptyBox">
      <h2>${loading ? `Récupération en cours` : `Aucune séance le ${esc(num)}`}</h2>
      <p>${loading
        ? `${info.theatersScanned}/${info.theatersTotal} salles récupérées pour le ${esc(num)}. Les séances apparaissent au fur et à mesure.`
        : `Essaie d'élargir les filtres ou de changer de date.`}</p>
      ${sorties ? `<div class="empty-actions">${sorties}</div>` : ''}
      ${state.filters.q.trim() ? `<p class="muted small" id="crossDate">Recherche sur les autres dates…</p>` : ''}
    </div>`;
    if (state.filters.q.trim()) suggestOtherDates();
    renderFilmSheet();
    return;
  }

  liste = state.view === 'hours'
    ? { type: 'hours', items: shows.slice().sort((a, b) => slot(a.s) - slot(b.s) || (state.day.movies[a.m]?.title || '').localeCompare(state.day.movies[b.m]?.title || '', 'fr')) }
    : { type: state.view, items: entries };
  const classe = { films: 'film-grid', theaters: 'cine-grid', hours: 'hr-list' }[state.view] || 'film-grid';
  renderFilmSheet();

  $('#results').innerHTML = sparseNotice() + cinesTrouves()
    + `<div class="${classe}" id="liste">${listeHTML(0, state.limit)}</div>` + boutonPlus();
  surveillerSuite();
}

/**
 * Rien à cette date ? Le film est peut-être programmé un autre jour — on va
 * chercher dans les journées déjà téléchargées plutôt que de laisser un vide.
 */
let crossToken = 0;
async function suggestOtherDates() {
  const token = ++crossToken;
  const query = state.filters.q.trim();
  const found = [];

  for (const d of state.index.days) {
    if (d.date === state.date) continue;
    const day = await loadDay(d.date);
    if (token !== crossToken) return; // la recherche a changé entre-temps
    if (!day) continue;

    const idx = searchIndex(day);
    const theaters = new Set();
    let n = 0;
    for (const s of day.shows) {
      const mask = (idx.movies.get(s.m) || 0) | (idx.theaters.get(s.t) || 0);
      if (mask === idx.full) { n++; theaters.add(s.t); }
    }
    if (n) found.push({ date: d.date, n, theaters: [...theaters] });
  }

  const box = $('#crossDate');
  if (!box || token !== crossToken) return;

  if (!found.length) {
    box.textContent = `« ${query} » n'est programmé à aucune des dates téléchargées.`;
    return;
  }

  box.outerHTML = `<div id="crossDate">
    <p>« ${esc(query)} » est programmé à d'autres dates :</p>
    <div class="chips" style="justify-content:center">
      ${found.map((f) => {
        const [label, num] = fmtDate(f.date);
        const where = f.theaters.length === 1
          ? state.byId.get(f.theaters[0])?.name ?? ''
          : plural(f.theaters.length, 'cinéma');
        return `<button class="chip" data-date="${f.date}">${esc(label)} ${esc(num)} — ${plural(f.n, 'séance')} · ${esc(where)}</button>`;
      }).join('')}
    </div>
  </div>`;
}

/* ---------------------------------------------------------- interactions */

function persist() {
  save('cineidf.filters', state.filters);
  save('cineidf.view', state.view);
  save('cineidf.sort', state.sort);
  // Les favoris partent aussi au serveur par la synchro : le scraper commence par ces salles.
  save('cineidf.favs', [...state.favs]);
}

function onFilterChange({ places = false } = {}) {
  state.limit = PAGE;
  state.expanded = new Set();
  if (places) refreshPlaceLists();
  persist();
  render();
}

$('#dates').addEventListener('click', (e) => {
  const b = e.target.closest('[data-date]');
  if (b) selectDate(b.dataset.date);
});

$('#depts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-dept]');
  if (!b) return;
  const code = b.dataset.dept;
  const list = state.filters.depts;
  const i = list.indexOf(code);
  if (i >= 0) list.splice(i, 1); else list.push(code);
  b.classList.toggle('active');
  onFilterChange({ places: true });
});

$('#versions').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  state.filters.version = b.dataset.v;
  for (const x of document.querySelectorAll('#versions .chip')) x.classList.toggle('active', x === b);
  onFilterChange();
});

$('#slots').addEventListener('click', (e) => {
  const b = e.target.closest('[data-from]');
  if (!b) return;
  state.filters.from = b.dataset.from;
  state.filters.to = b.dataset.to;
  $('#from').value = b.dataset.from;
  $('#to').value = b.dataset.to;
  for (const x of document.querySelectorAll('#slots .chip')) x.classList.toggle('active', x === b);
  onFilterChange();
});

function setView(view) {
  state.view = view;
  for (const x of document.querySelectorAll('#view .chip')) x.classList.toggle('active', x.dataset.view === view);
  onFilterChange();
}

$('#view').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (!b) return;
  openFilm(null);
  setView(b.dataset.view);
});

/* Barre du bas (téléphone) : les vues de la liste, puis mes séances et les filtres. */
$('#tabbar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  const tab = b.dataset.tab;
  if (tab === 'cart' || tab === 'filters') return togglePanel(tab);
  const dejaLa = tab === state.view && state.filmOpen == null && !state.panel;
  openFilm(null);
  if (dejaLa) return scrollTo({ top: 0, behavior: 'smooth' });
  setView(tab);
  scrollTo(0, 0);
});

/* Raccourcis du téléphone : les mêmes filtres que dans l'écran Filtres. */
function basculerHoraire(from, to) {
  const f = state.filters;
  const deja = f.from === from && f.to === to;
  f.from = deja ? '' : from;
  f.to = deja ? '' : to;
}
$('#quick').addEventListener('click', (e) => {
  const b = e.target.closest('[data-quick]');
  if (!b) return;
  const f = state.filters;
  switch (b.dataset.quick) {
    case 'soir': basculerHoraire('18:00', '23:59'); break;
    case 'aprem': basculerHoraire('13:00', '18:00'); break;
    case 'vo': f.version = f.version === 'VO' ? '' : 'VO'; break;
    case 'vf': f.version = f.version === 'VF' ? '' : 'VF'; break;
    case 'fav': f.onlyFav = !f.onlyFav; break;
    case 'avoir': f.onlyWatchlist = !f.onlyWatchlist; break;
    case 'note': f.minNote = !f.minNote; break;
    case 'proche':
      if (state.origin) { f.radius = ''; setOrigin(null); return; }
      return localiser(() => { state.sort = 'near'; $('#sort').value = 'near'; persist(); render(); });
    default: return;
  }
  buildStaticFilters();
  onFilterChange();
});

let timer;
function appliquerRecherche(v, attendre = 180) {
  clearTimeout(timer);
  $('#qClear').hidden = !v;
  timer = setTimeout(() => {
    state.filters.q = v;
    onFilterChange();
    // Sur téléphone, les résultats doivent se voir sans remonter à la main.
    if (matchMedia('(max-width: 900px)').matches) scrollTo(0, 0);
  }, attendre);
}
$('#q').addEventListener('input', (e) => appliquerRecherche(e.target.value));
$('#q').addEventListener('keydown', (e) => {
  // « Rechercher » sur le clavier de l'iPhone : on le range pour voir les résultats.
  if (e.key === 'Enter') e.target.blur();
});
$('#qClear').addEventListener('click', () => {
  $('#q').value = '';
  appliquerRecherche('', 0);
  $('#q').focus();
});

$('#city').addEventListener('change', (e) => { state.filters.city = e.target.value; onFilterChange({ places: true }); });
$('#theater').addEventListener('change', (e) => { state.filters.theater = e.target.value; onFilterChange(); });
$('#genre').addEventListener('change', (e) => { state.filters.genre = e.target.value; onFilterChange(); });
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; onFilterChange(); });

for (const [id, key] of [['from', 'from'], ['to', 'to']]) {
  $(`#${id}`).addEventListener('change', (e) => {
    state.filters[key] = e.target.value;
    for (const x of document.querySelectorAll('#slots .chip')) x.classList.remove('active');
    onFilterChange();
  });
}
for (const [id, key] of [['onlyFav', 'onlyFav'], ['hidePast', 'hidePast'], ['hidePreview', 'hidePreview'], ['minNote', 'minNote']]) {
  $(`#${id}`).addEventListener('change', (e) => { state.filters[key] = e.target.checked; onFilterChange(); });
}

$('#reset').addEventListener('click', () => {
  state.filters = { q: '', depts: [], city: '', theater: '', version: '', from: '', to: '', genre: '', onlyFav: false, hidePast: true, hidePreview: false, radius: '', onlyWatchlist: false, ugcOnly: true, minNote: false };
  buildStaticFilters();
  buildGenres();
  onFilterChange();
});

$('#filtersClose').addEventListener('click', () => fermerUi());
$('#filtersApply').addEventListener('click', () => { fermerUi(); scrollTo(0, 0); });
$('#refreshPhone').addEventListener('click', () => startRefresh());

/* ---------------------------------------------------------- panier (UI) */

$('#cartFab').addEventListener('click', () => togglePanel('cart'));
$('#cartClose').addEventListener('click', () => fermerUi());
$('#toastUndo').addEventListener('click', () => {
  $('#toast').hidden = true;
  if (toastAnnuler) toastAnnuler();
});

/** Remet les pastilles visibles en accord avec le panier, sans tout redessiner. */
function syncChips() {
  for (const chip of document.querySelectorAll('[data-show]')) {
    try {
      const kept = cartHas(state.date, JSON.parse(chip.dataset.show));
      chip.classList.toggle('kept', kept);
      chip.title = chipTitle(kept, chip.classList.contains('preview'), chip.classList.contains('unconfirmed'));
    } catch { /* attribut illisible */ }
  }
}

$('#cartClear').addEventListener('click', () => {
  state.cart = [];
  state.cartKeys = new Set();
  save('cineidf.cart', []);
  renderCart();
  syncChips();
});

$('#cartSync').addEventListener('click', (e) => {
  if (!e.target.closest('[data-sync-now]')) return;
  synchro.erreur = '';
  $('#cartSync').textContent = 'Synchronisation avec le PC…';
  syncPerso();
});

$('#cartBody').addEventListener('click', (e) => {
  const del = e.target.closest('[data-cart-del]');
  if (del) {
    state.cart = state.cart.filter((x) => cartKey(x) !== del.dataset.cartDel);
    state.cartKeys = new Set(state.cart.map(cartKey));
    save('cineidf.cart', state.cart);
    renderCart();
    syncChips();
    return;
  }
  if (e.target.id === 'cartPurge') {
    state.cart = state.cart.filter((x) => !cartPassee(x));
    state.cartKeys = new Set(state.cart.map(cartKey));
    save('cineidf.cart', state.cart);
    renderCart();
    syncChips();
    return;
  }
  const partage = e.target.closest('[data-cart-share]');
  if (partage) {
    const x = state.cart.find((c) => cartKey(c) === partage.dataset.cartShare);
    if (x) navigator.share({ text: phraseSeance(x), ...(x.u ? { url: x.u } : {}) }).catch(() => { /* partage annulé */ });
    return;
  }
  // Cliquer la date du groupe ramène à cette journée dans la liste.
  const jour = e.target.closest('[data-cart-date]');
  if (jour) {
    if (jour.dataset.cartDate !== state.date) selectDate(jour.dataset.cartDate);
    fermerUi();
  }
});





/**
 * La watchlist ne peut pas se rafraichir toute seule : Letterboxd est derriere
 * un challenge Cloudflare que seul ton navigateur resout. On te le rappelle donc
 * au lancement, avec le chemin le plus court pour la remettre a jour.
 */
function rappelerWatchlist() {
  if (state.lbStatus?.pseudo) return; // relue toute seule : rien à rappeler
  const age = watchlistAgeDays();
  if (age === null || age < 3) return;
  const pseudo = load('cineidf.lbUser', null);
  const lien = pseudo ? `https://letterboxd.com/${pseudo}/watchlist/` : 'https://letterboxd.com/';
  setStatus('ok', `Ta watchlist date de ${plural(age, 'jour')} — ouvre-la et clique le marque-page pour la rafraîchir.`,
    { openUrl: lien });
}

/**
 * Repli du marque-page : si le navigateur refuse l'envoi direct vers localhost,
 * il ouvre l'app avec la liste dans l'adresse. On la lit puis on nettoie l'URL.
 */
function lireWatchlistDansAdresse() {
  const m = location.hash.match(/^#wl=(.+)$/);
  if (!m) return false;
  try {
    const recu = JSON.parse(decodeURIComponent(m[1]));
    const brut = Array.isArray(recu) ? recu : recu.films ?? [];
    if (recu.pseudo) save('cineidf.lbUser', recu.pseudo);
    const films = brut
      .filter((f) => f && f.titre)
      .map((f) => ({ title: String(f.titre).slice(0, 300), year: Number(f.annee) || null }));
    history.replaceState(null, '', location.pathname);
    if (!films.length) return false;

    state.watchlist = films;
    state.wlImportedAt = new Date().toISOString();
    save('cineidf.watchlist', films);
    save('cineidf.wlDate', state.wlImportedAt);
    return true;
  } catch {
    history.replaceState(null, '', location.pathname);
    return false;
  }
}

/**
 * Watchlist envoyée directement depuis Letterboxd par le marque-page.
 * Prioritaire sur l'export CSV : c'est la source la plus fraîche.
 */
async function recupererWatchlistPoussee() {
  const data = await getJSON('/api/watchlist/pushed');
  const statut = await getJSON('/api/watchlist/status');
  if (statut) { state.lbStatus = statut; renderWatchlist(); }
  // Une synchro auto peut légitimement ramener une liste vide.
  if (!data?.films || (!data.films.length && data.source !== 'auto')) return false;
  if (state.wlImportedAt && Date.parse(data.recuLe) <= Date.parse(state.wlImportedAt)) return true;

  const avant = state.watchlist?.length ?? null;
  if (data.pseudo) save('cineidf.lbUser', data.pseudo);
  state.watchlist = data.films.map((f) => ({ title: f.title, year: f.year, slug: f.slug || null }));
  state.wlImportedAt = data.recuLe;
  save('cineidf.watchlist', state.watchlist);
  save('cineidf.wlDate', state.wlImportedAt);
  state.wlHits = watchlistMatches(state.day);
  renderWatchlist();
  render();
  // Synchro auto silencieuse si rien n'a bougé ; sinon, on le dit.
  if (!(data.source === 'auto' && avant === state.watchlist.length)) {
    setStatus('ok', `Watchlist Letterboxd à jour — ${plural(state.watchlist.length, 'film')}, ${state.wlHits.size} à l'affiche`, { autoHide: 6000 });
  }
  return true;
}

/**
 * Detection automatique d'un export Letterboxd depose dans Telechargements.
 * Evite d'avoir a dezipper et a choisir le fichier a chaque fois : si l'export
 * est plus recent que le dernier import, on le prend tout seul.
 */
async function detecterExportLetterboxd() {
  const info = await getJSON('/api/watchlist/export');
  const trouve = info?.trouve;
  if (!trouve) return;

  // Deja importe ? On ne redemande rien.
  if (state.wlImportedAt && Date.parse(trouve.modifieLe) <= Date.parse(state.wlImportedAt)) return;

  const res = await fetch('/api/watchlist/import', { method: 'POST' });
  if (!res.ok) return;
  const data = await res.json();

  const items = parseWatchlist(data.csv);
  if (!items.length) return;

  state.watchlist = items;
  state.wlImportedAt = data.modifieLe;
  save('cineidf.watchlist', items);
  save('cineidf.wlDate', state.wlImportedAt);
  state.wlHits = watchlistMatches(state.day);
  renderWatchlist();
  render();

  state.exportDetecte = data.nom;
  const resume = `${plural(items.length, 'film')}, ${state.wlHits.size} à l’affiche`;
  setStatus('ok', `Watchlist reprise depuis ${data.nom} — ${resume}`, { cleanup: true });
}


/* ------------------------------------------------ liste à voir, saisie libre */

function renderPerso() {
  const zone = $('#wlPerso');
  if (!state.wlPerso.length) { zone.innerHTML = ''; return; }
  zone.innerHTML = state.wlPerso.map((f, i) => {
    const vu = state.wlHits.size && state.day
      && Object.values(state.day.movies).some((m) => noteTitresEgaux(m, f));
    return `<div class="perso-item${vu ? ' a-laffiche' : ''}">
      <span>${esc(f.title)}${f.year ? ` <i>${f.year}</i>` : ''}</span>
      <button class="fav" data-perso="${i}" title="Retirer">✕</button>
    </div>`;
  }).join('');
}

/** Même comparaison que pour la watchlist Letterboxd : titre normalisé + année. */
function noteTitresEgaux(m, f) {
  const cible = norm(f.title);
  if (!cible) return false;
  for (const candidat of [m.title, m.originalTitle]) {
    if (candidat && norm(candidat) === cible) {
      return !f.year || !m.year || Math.abs(f.year - m.year) <= 1;
    }
  }
  return false;
}


/**
 * "Parasite 2019" ou "Parasite (2019)" -> { title: 'Parasite', year: 2019 }.
 * Découpage à la main plutôt qu'une expression régulière : plus lisible, et
 * l'année n'est retenue que si un titre subsiste devant.
 */
function separerTitreEtAnnee(saisie) {
  const nettoye = saisie.trim().replace(/[()\s]+$/, '');
  const mots = nettoye.split(/\s+/);
  const dernier = mots[mots.length - 1]?.replace(/[()]/g, '') ?? '';
  // Borne haute a l'annee prochaine : sinon "Blade Runner 2049" perdrait son titre.
  const max = new Date().getFullYear() + 1;
  const estAnnee = dernier.length === 4 && Number(dernier) >= 1900 && Number(dernier) <= max;

  if (estAnnee && mots.length > 1) {
    return { title: mots.slice(0, -1).join(' ').replace(/[(\s]+$/, ''), year: Number(dernier) };
  }
  return { title: nettoye, year: null };
}
function ajouterFilmPerso() {
  const champ = $('#wlAdd');
  const brut = champ.value.trim();
  if (!brut) return;
  const film = separerTitreEtAnnee(brut);

  if (!state.wlPerso.some((f) => norm(f.title) === norm(film.title) && f.year === film.year)) {
    state.wlPerso = [film, ...state.wlPerso];
    save('cineidf.wlPerso', state.wlPerso);
  }
  champ.value = '';
  state.wlHits = watchlistMatches(state.day);
  renderWatchlist();
  renderPerso();
  render();
}

$('#wlAddBtn').addEventListener('click', ajouterFilmPerso);
$('#wlAdd').addEventListener('keydown', (e) => { if (e.key === 'Enter') ajouterFilmPerso(); });
$('#wlPerso').addEventListener('click', (e) => {
  const b = e.target.closest('[data-perso]');
  if (!b) return;
  state.wlPerso = state.wlPerso.filter((_, i) => i !== Number(b.dataset.perso));
  save('cineidf.wlPerso', state.wlPerso);
  state.wlHits = watchlistMatches(state.day);
  renderWatchlist();
  renderPerso();
  render();
});

/* ------------------------------------------------------- watchlist (UI) */

/**
 * Les films de ta watchlist qui passent dans les jours récupérés, avec les
 * jours concernés. Mêmes critères de lieu que la liste (carte UGC, départements,
 * favoris…). Recalculé seulement quand la watchlist, les données ou ces
 * critères changent.
 */
let wlWeekKey = '';
let wlWeekToken = 0;
async function renderWlWeek() {
  const f = state.filters;
  const cle = JSON.stringify([state.index?.generatedAt, state.index?.days?.map((d) => d.shows),
    state.watchlist?.length, state.wlLocal.size, state.wlPerso.length, f.ugcOnly, f.onlyFav, f.depts, f.city, f.theater, f.version,
    Object.keys(state.ratings).length, todayStr()]);
  if (cle === wlWeekKey) return;
  wlWeekKey = cle;
  const token = ++wlWeekToken;
  const box = $('#wlWeek');
  const aVoir = Boolean(state.watchlist?.length) || state.wlLocal.size > 0 || state.wlPerso.length > 0;
  if (!aVoir || !state.index) { box.hidden = true; return; }

  const garde = (x) => {
    const t = state.byId.get(x.t);
    if (!t) return false;
    if (f.ugcOnly && !t.ugc) return false;
    if (f.onlyFav && !state.favs.has(x.t)) return false;
    if (f.depts.length && !f.depts.includes(t.dept)) return false;
    if (f.city && t.city !== f.city) return false;
    if (f.theater && x.t !== f.theater) return false;
    if (f.version === 'VO' && x.v === 'VF') return false;
    if (f.version === 'VF' && x.v !== 'VF') return false;
    return true;
  };
  const auj = todayStr();
  const maintenant = slot(nowHHMM());
  const films = new Map(); // id -> { m, jours: [date] }
  for (const d of state.index.days) {
    const day = await loadDay(d.date);
    if (token !== wlWeekToken) return; // recalcul relancé entre-temps
    if (!day) continue;
    const ids = watchlistMatches(day);
    if (!ids.size) continue;
    const presents = new Set(day.shows
      .filter((x) => ids.has(x.m) && garde(x) && !(d.date === auj && slot(x.s) < maintenant))
      .map((x) => x.m));
    for (const id of presents) {
      if (!films.has(id)) films.set(id, { m: day.movies[id], jours: [] });
      films.get(id).jours.push(d.date);
    }
  }
  if (!films.size) { box.hidden = true; return; }

  const liste = [...films.values()].sort((a, b) => a.jours[0].localeCompare(b.jours[0]) || a.m.title.localeCompare(b.m.title, 'fr'));
  $('#wlWeekRow').innerHTML = liste.map(({ m, jours }) => {
    const quand = jours.map((j) => (j === auj ? "auj." : fmtDate(j)[0])).join(', ');
    const vignette = thumb(m.poster);
    return `<button class="wl-week-item" data-wl-film="${m.id}" data-wl-date="${jours[0]}" title="Voir les séances">
      <span class="wl-week-poster">${vignette ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(vignette)}" alt="">` : ''}</span>
      <span class="wl-week-name">${esc(m.title)}</span>
      <span class="wl-week-days">${esc(quand)}</span>
    </button>`;
  }).join('');
  $('#wlWeek').querySelector('.wl-week-title').textContent =
    `Ta watchlist cette semaine · ${plural(liste.length, 'film')}`;
  box.hidden = false;
}

$('#wlWeekRow').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-wl-film]');
  if (!b) return;
  if (b.dataset.wlDate !== state.date) await selectDate(b.dataset.wlDate);
  openFilm(b.dataset.wlFilm, 'film');
});

/** « à l'instant », « il y a 5 min », « il y a 2 h », « le 12 oct ». */
function ilYa(iso) {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  if (min < 24 * 60) return `il y a ${Math.round(min / 60)} h`;
  return `le ${new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }).replace('.', '')}`;
}

function renderWatchlist() {
  const lb = state.lbStatus;
  const lie = Boolean(lb?.pseudo);
  const active = Boolean(state.watchlist?.length) || state.wlLocal.size > 0 || state.wlPerso.length > 0;
  $('#lbSetup').hidden = lie;
  $('#lbLinked').hidden = !lie;
  $('#lbChange').hidden = !lie;
  $('#wlEmpty').hidden = lie;                 // l'import de fichier ne sert qu'en secours
  $('#wlLoaded').hidden = !active;
  $('#wlFileBox').hidden = lie || !state.watchlist?.length;
  $('#onlyWatchlist').checked = state.filters.onlyWatchlist;
  if (!active) state.filters.onlyWatchlist = false; // filtre sans objet

  const n = state.wlHits.size;
  // « à l'affiche » est invariable : pas de plural() ici.
  const affiche = n ? `${n} à l’affiche` : 'aucun à l’affiche';
  if (lie) {
    $('#lbLabel').textContent = `${lb.pseudo} · ${plural(state.watchlist?.length || 0, 'film')} · ${affiche}`;
    const etat = $('#lbState');
    etat.classList.toggle('error', lb.ok === false && !state.lbSyncing);
    etat.textContent = state.lbSyncing
      ? 'Synchronisation…'
      : lb.ok === false
        ? `Dernier essai raté (${ilYa(lb.at)}) : ${lb.error}`
        : lb.at ? `Synchronisée ${ilYa(lb.at)} · relue toute seule à chaque ouverture` : '';
  } else if (state.watchlist?.length) {
    const total = state.watchlist.length + state.wlLocal.size + state.wlPerso.length;
    $('#wlLabel').textContent = `Fichier importé · ${plural(total, 'film')} · ${affiche}`;
  }

  // Ancien import par fichier : il vieillit, on le signale sans être pénible.
  const age = watchlistAgeDays();
  const rappel = $('#wlAge');
  if (!lie && state.watchlist?.length && age !== null && age >= 14) {
    rappel.hidden = false;
    rappel.textContent = `Fichier importé il y a ${age} jours. Relie plutôt ton pseudo ci-dessus : plus rien à refaire.`;
  } else {
    rappel.hidden = true;
  }
}

/** Pseudo tapé, ou adresse de profil collée (« letterboxd.com/pseudo/… »). */
function lirePseudo(saisie) {
  const t = saisie.trim();
  const url = t.match(/letterboxd\.com\/([A-Za-z0-9_-]+)/i);
  return (url ? url[1] : t.replace(/^@/, '')).trim();
}

async function relierLetterboxd() {
  const pseudo = lirePseudo($('#lbUser').value);
  const hint = $('#lbSetupHint');
  if (!pseudo) { $('#lbUser').focus(); return; }
  $('#lbUserBtn').disabled = true;
  hint.classList.remove('error');
  hint.textContent = 'Lecture de ta watchlist…';
  try {
    const res = await fetch('/api/watchlist/user', { method: 'POST', body: JSON.stringify({ pseudo }) });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'échec');
    state.lbStatus = r;
    await recupererWatchlistPoussee();
    renderWatchlist();
  } catch (err) {
    hint.classList.add('error');
    hint.textContent = `Impossible de lire cette watchlist : ${err.message}.`;
  } finally {
    $('#lbUserBtn').disabled = false;
  }
}

async function synchroniserLetterboxd() {
  state.lbSyncing = true;
  $('#lbSync').disabled = true;
  renderWatchlist();
  try {
    const res = await fetch('/api/watchlist/sync', { method: 'POST' });
    state.lbStatus = await res.json().catch(() => state.lbStatus);
  } catch { /* serveur injoignable : l'état reste affiché */ }
  state.lbSyncing = false;
  $('#lbSync').disabled = false;
  await recupererWatchlistPoussee();
  renderWatchlist();
}

$('#lbUserBtn').addEventListener('click', relierLetterboxd);
$('#lbUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') relierLetterboxd(); });
$('#lbSync').addEventListener('click', synchroniserLetterboxd);
$('#lbChange').addEventListener('click', async () => {
  const ancien = state.lbStatus?.pseudo || '';
  await fetch('/api/watchlist/user', { method: 'POST', body: JSON.stringify({ pseudo: null }) }).catch(() => {});
  state.lbStatus = { pseudo: null };
  renderWatchlist();
  $('#lbUser').value = ancien;
  $('#lbUser').focus();
  $('#lbUser').select();
});

$('#wlFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ''; // permet de réimporter le même fichier
  if (!file) return;

  const items = parseWatchlist(await file.text());
  if (!items.length) {
    setStatus('error', "Ce fichier ne ressemble pas à un watchlist.csv Letterboxd (colonnes Name et Year attendues).", { autoHide: 10000 });
    return;
  }
  state.watchlist = items;
  state.wlImportedAt = new Date().toISOString();
  save('cineidf.watchlist', items);
  save('cineidf.wlDate', state.wlImportedAt);
  state.wlHits = watchlistMatches(state.day);
  renderWatchlist();
  render();
  setStatus('ok', `Watchlist importée — ${plural(items.length, 'film')}, ${state.wlHits.size} à l’affiche aujourd’hui`, { autoHide: 7000 });
});

$('#wlClear').addEventListener('click', () => {
  state.watchlist = null;
  state.wlImportedAt = null;
  state.wlLocal = new Set();
  state.wlHits = new Set();
  state.filters.onlyWatchlist = false;
  for (const k of ['cineidf.watchlist', 'cineidf.wlDate', 'cineidf.wlLocal']) localStorage.removeItem(k);
  renderWatchlist();
  onFilterChange();
});

$('#onlyWatchlist').addEventListener('change', (e) => {
  state.filters.onlyWatchlist = e.target.checked;
  onFilterChange();
});

/* --------------------------------------------------------- point de départ */

function renderOrigin() {
  const box = $('#origin');
  box.hidden = !state.origin;
  if (state.origin) $('#originLabel').textContent = state.origin.label;
  $('#radius').value = state.filters.radius || '';
  // Le tri par distance n'a pas de sens sans point de départ.
  $('#sort').querySelector('[value="near"]').disabled = !state.origin;
  if (!state.origin && state.sort === 'near') { state.sort = 'popular'; $('#sort').value = 'popular'; }
}

function setOrigin(origin) {
  state.origin = origin;
  save('cineidf.origin', origin);
  $('#addrHits').hidden = true;
  $('#addr').value = '';
  renderOrigin();
  onFilterChange();
}

/** Demande la position, puis en fait le point de départ. */
function localiser(apres = null) {
  if (!navigator.geolocation) return alert("La géolocalisation n'est pas disponible.");
  $('#locate').textContent = '⏳ …';
  toast('Recherche de ta position…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $('#locate').textContent = 'Ma position';
      $('#toast').hidden = true;
      setOrigin({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Ma position' });
      if (apres) apres();
    },
    () => {
      $('#locate').textContent = 'Ma position';
      $('#toast').hidden = true;
      alert("Position refusée ou indisponible. Tu peux saisir une adresse dans les filtres.");
    },
    { enableHighAccuracy: true, timeout: 10000 },
  );
}
$('#locate').addEventListener('click', () => localiser());

let addrTimer;
let addrToken = 0;
$('#addr').addEventListener('input', (e) => {
  clearTimeout(addrTimer);
  const q = e.target.value.trim();
  if (q.length < 3) return void ($('#addrHits').hidden = true);

  const token = ++addrToken;
  addrTimer = setTimeout(async () => {
    const data = await getJSON(`/api/geocode?q=${encodeURIComponent(q)}`);
    if (token !== addrToken) return; // une frappe plus récente a pris la main
    const hits = data?.results ?? [];
    const box = $('#addrHits');
    box.hidden = !hits.length;
    box.innerHTML = hits
      .map((h, i) => `<button class="chip" data-hit="${i}">${esc(h.label)}</button>`)
      .join('');
    box.__hits = hits;
  }, 350);
});

$('#addrHits').addEventListener('click', (e) => {
  const b = e.target.closest('[data-hit]');
  if (!b) return;
  const h = $('#addrHits').__hits[Number(b.dataset.hit)];
  if (h) setOrigin({ lat: h.lat, lon: h.lon, label: h.label });
});

$('#clearOrigin').addEventListener('click', () => {
  state.filters.radius = '';
  setOrigin(null);
});

$('#radius').addEventListener('change', (e) => {
  state.filters.radius = e.target.value;
  onFilterChange();
});

function onResultsClick(e) {
  // D'abord ce qui est à l'intérieur d'une ligne cliquable : un lien, un ticket.
  if (e.target.closest('a')) return;

  const chip = e.target.closest('[data-show]');
  if (chip) {
    try {
      const show = JSON.parse(chip.dataset.show);
      cartToggle(state.date, show);
      // On repeint uniquement la pastille cliquée : un render() complet ferait
      // sauter la position de défilement, ce que le panier est censé éviter.
      const kept = cartHas(state.date, show);
      chip.classList.toggle('kept', kept);
      chip.title = chipTitle(kept, chip.classList.contains('preview'), chip.classList.contains('unconfirmed'));
    } catch { /* attribut illisible */ }
    return;
  }

  const mode = e.target.closest('[data-sheet-mode]');
  if (mode) {
    state.sheetMode = mode.dataset.sheetMode;
    save('cineidf.sheetMode', state.sheetMode);
    renderFilmSheet();
    return;
  }

  const synopsis = e.target.closest('.card-synopsis');
  if (synopsis) return void synopsis.classList.toggle('open');

  if (e.target.closest('[data-reset]')) return void $('#reset').click();

  const jump = e.target.closest('[data-date]');
  if (jump) return selectDate(jump.dataset.date);

  const wl = e.target.closest('[data-wl]');
  if (wl) {
    const id = wl.dataset.wl;
    state.wlLocal.has(id) ? state.wlLocal.delete(id) : state.wlLocal.add(id);
    save('cineidf.wlLocal', [...state.wlLocal]);
    state.wlHits = watchlistMatches(state.day);
    renderWatchlist();
    render();
    return;
  }

  const fav = e.target.closest('[data-fav]');
  if (fav) {
    const id = fav.dataset.fav;
    state.favs.has(id) ? state.favs.delete(id) : state.favs.add(id);
    persist();
    render();
    return;
  }

  const tile = e.target.closest('[data-film]');
  if (tile) return openFilm(tile.dataset.film, 'film');
  const cineTile = e.target.closest('[data-cine]');
  if (cineTile) return openFilm(cineTile.dataset.cine, 'theater');

  const exp = e.target.closest('[data-expand]');
  if (exp) {
    const k = exp.dataset.expand;
    state.expanded.has(k) ? state.expanded.delete(k) : state.expanded.add(k);
    render();
    return;
  }
  if (e.target.id === 'loadMore') afficherPlus();
}
$('#results').addEventListener('click', onResultsClick);
$('#filmSheetBody').addEventListener('click', onResultsClick);
for (const el of document.querySelectorAll('[data-close-film]')) el.addEventListener('click', () => openFilm(null));

/* ------------------------------------------------------------ mise a jour */

async function startRefresh() {
  setStatus('loading', 'Démarrage de la mise à jour…');
  const res = await fetch('/api/refresh?days=5', { method: 'POST' });
  if (res.status === 409) {
    setStatus('loading', 'Une mise à jour est déjà en cours…');
  }
  watchRefresh();
}

$('#refreshBtn').addEventListener('click', startRefresh);
$('#statusRetry').addEventListener('click', startRefresh);
// Arrow et pas référence directe : hideStatus est déclaré plus bas dans le fichier.
$('#statusClose').addEventListener('click', () => hideStatus());

// Suppression de l'export une fois repris : evite que les zip s'accumulent
// dans Telechargements. Uniquement sur clic explicite.
$('#statusCleanup').addEventListener('click', async () => {
  const res = await fetch('/api/watchlist/cleanup', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  setStatus(res.ok ? 'ok' : 'error',
    res.ok ? `${data.supprime} supprimé de Téléchargements` : (data.error || 'Suppression impossible'),
    { autoHide: 5000 });
});
$('#statusDetails').addEventListener('click', () => {
  const log = $('#statusLog');
  log.hidden = !log.hidden;
  $('#statusDetails').textContent = log.hidden ? 'Détails' : 'Masquer';
});

/**
 * Une mise a jour peut avoir ete lancee par le serveur au demarrage : on la
 * signale discretement, et on recharge la page quand elle se termine.
 */
/**
 * Aucune donnée exploitable (première ouverture, ou app laissée de côté assez
 * longtemps pour que tout soit périmé) : le serveur a déjà relancé une
 * récupération, on affiche sa progression et on démarre dès la première journée.
 */
async function waitForFirstData() {
  const paint = (msg, detail = '') => {
    $('#results').innerHTML = `<div class="empty">
      <h2>${msg}</h2>
      <p>L'app télécharge les séances des cinémas d'Île-de-France.<br>
      Elle s'affiche dès que la première journée est prête, sans rien faire de ton côté.</p>
      ${detail ? `<p class="muted small">${esc(detail)}</p>` : ''}</div>`;
  };
  paint('Récupération en cours…');

  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    const [index, st] = await Promise.all([getJSON('/api/index'), getJSON('/api/refresh')]);
    if (index) return location.reload();          // une journée est exploitable

    if (st?.running) {
      setStatus('loading', progressText(st.progress), { percent: progressRatio(st.progress) });
      paint('Récupération en cours…', st.log.at(-1) || '');
    } else {
      reportLastResult(st?.last);
      paint('Aucune donnée', 'Clique sur « Mettre à jour » en haut à droite.');
    }
  }
}

/* ------------------------------------------------------------ barre d'état */

let hideStatusTimer;
function setStatus(state, text, { percent = null, details = null, retry = false, autoHide = 0, cleanup = false, openUrl = null } = {}) {
  clearTimeout(hideStatusTimer);
  const box = $('#status');
  box.hidden = false;
  box.dataset.state = state;
  $('#statusText').textContent = text;

  const fill = $('#statusFill');
  fill.classList.toggle('indeterminate', state === 'loading' && percent == null);
  fill.style.width = percent == null ? (state === 'loading' ? '' : '100%') : `${Math.round(percent * 100)}%`;

  $('#statusRetry').hidden = !retry;
  $('#statusCleanup').hidden = !cleanup;
  $('#statusOpen').hidden = !openUrl;
  if (openUrl) $('#statusOpen').href = openUrl;
  $('#statusDetails').hidden = !details;
  $('#statusLog').textContent = details || '';
  if (!details) $('#statusLog').hidden = true;

  if (autoHide) hideStatusTimer = setTimeout(() => { box.hidden = true; }, autoHide);
}

const hideStatus = () => { clearTimeout(hideStatusTimer); $('#status').hidden = true; };

/** "jour 2/5 · 168/362 salles · 4 812 séances" */
function progressText(p) {
  if (!p) return 'Mise à jour en cours…';
  const parts = [];
  if (p.days > 1) parts.push(`jour ${p.day}/${p.days}`);
  parts.push(`${p.done}/${p.total} salles`);
  if (p.shows) parts.push(`${p.shows.toLocaleString('fr-FR')} séances`);
  return `Mise à jour · ${parts.join(' · ')}`;
}

const progressRatio = (p) =>
  p && p.total && p.days ? Math.min(1, ((p.day - 1) + p.done / p.total) / p.days) : null;

/**
 * Suit une mise à jour du début à la fin : progression chiffrée, rafraîchissement
 * des données déjà écrites, puis message de succès ou d'échec explicite.
 */
let watching = false;
async function watchRefresh() {
  const first = await getJSON('/api/refresh');
  if (!first) return;

  if (!first.running) {
    reportLastResult(first.last);
    return;
  }
  if (watching) return;
  watching = true;

  $('#refreshBtn').textContent = 'Mise à jour…';
  $('#refreshBtn').disabled = true;
  setStatus('loading', progressText(first.progress), { percent: progressRatio(first.progress) });

  let ticks = 0;
  const timer = setInterval(async () => {
    ticks++;
    const now = await getJSON('/api/refresh');
    if (!now) return;

    if (now.running) {
      setStatus('loading', progressText(now.progress), { percent: progressRatio(now.progress) });
      // Toutes les 15 s : on recharge ce qui est déjà écrit, sans perdre les filtres.
      if (ticks % 5 === 0) await softRefresh();
      return;
    }

    clearInterval(timer);
    watching = false;
    $('#refreshBtn').textContent = 'Mettre à jour';
    $('#refreshBtn').disabled = false;
    await softRefresh();
    reportLastResult(now.last ?? { code: now.code, error: now.error, summary: now.summary, at: new Date().toISOString() });
  }, 3000);
}

/**
 * Traduit le résultat d'une mise à jour en message lisible.
 * Un même résultat n'est annoncé qu'une fois : sans ça, le suivi périodique
 * ferait réapparaître une bannière que tu viens de fermer.
 */
let reportedAt = null;
function reportLastResult(last) {
  if (!last) return hideStatus();
  if (last.at === reportedAt) return;
  reportedAt = last.at;

  const ageMin = (Date.now() - Date.parse(last.at)) / 60000;
  const details = (last.tail || []).join('\n') || null;

  if (last.code === 0) {
    // On ne fête le succès que s'il vient de se produire.
    if (ageMin > 2) return hideStatus();
    const s = last.summary;
    const quoi = s
      ? `${s.shows.toLocaleString('fr-FR')} séances · ${s.theaters} cinémas · ${plural(s.days, 'jour')}`
      : 'données à jour';
    setStatus('ok', `Tout est à jour — ${quoi}`, { autoHide: 8000 });
    return;
  }

  const quand = ageMin < 60
    ? `il y a ${Math.max(1, Math.round(ageMin))} min`
    : new Date(last.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  const message = last.error?.message || 'La mise à jour a échoué.';
  setStatus('error', `Échec de la mise à jour (${quand}) — ${message}`, { retry: true, details });
}

/**
 * « 104 cinémas · à jour à 19h40 » : le nombre de salles réellement couvertes
 * (périmètre UGC ou toutes), et l'heure de mise à jour, avec le jour si ce
 * n'est pas aujourd'hui.
 */
function metaText() {
  // L'heure de la journée affichée, pas la plus récente de toutes : c'est celle
  // qui dit si ce qu'on regarde est à jour.
  const jourAffiche = state.index.days.find((d) => d.date === state.date);
  const gen = new Date(jourAffiche?.fetchedAt || state.index.generatedAt);
  const salles = state.theaters?.length
    ? state.theaters.filter((t) => !state.filters.ugcOnly || t.ugc).length
    : state.index.theaterCount;
  const heure = gen.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }).replace(':', 'h');
  const jour = gen.toDateString() === new Date().toDateString()
    ? ''
    : ` le ${gen.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }).replace('.', '')}`;
  return `${salles} cinémas · à jour${jour} à ${heure}` + (state.index.partial ? ' · récupération en cours' : '');
}

/** Recharge index + journée courante sans perdre filtres, tri ni position. */
async function softRefresh() {
  const index = await getJSON('/api/index');
  if (!index) return;
  const inchange = JSON.stringify(index.days) === JSON.stringify(state.index?.days);
  state.index = index;

  // Toutes les journées ont pu changer, pas seulement celle affichée — et les
  // notes Letterboxd sont complétées à la fin de chaque mise à jour.
  if (!inchange) {
    dayCache.clear();
    // Les séances gardées sont recontrôlées dès que les journées sont revenues.
    if (state.cart.length) prechargerJours().catch(() => {});
  }
  state.ratings = (await getJSON('/api/ratings')) || state.ratings;
  const day = await loadDay(state.date);
  if (!day) return;

  state.day = day;
  state.search = null; // les masques dépendent du contenu de la journée
  renderDates();
  renderUgc();
  buildGenres();
  render();
  $('#meta').textContent = metaText();
}

// Connexion maintenue ouverte : elle signale au serveur que l'app est ouverte.
// Un setInterval ne suffirait pas — le navigateur gèle les minuteries d'une
// fenêtre en arrière-plan, alors que la connexion, elle, tient.
// À la fermeture de la fenêtre, la socket tombe et le serveur s'arrête seul.
try { new EventSource('/api/alive'); } catch { /* pas bloquant */ }

/* ------------------------------------------------------------ sur mon iPhone */

const surLePC = ['localhost', '127.0.0.1'].includes(location.hostname);

/**
 * Guide pas à pas pour avoir l'app sur l'iPhone, selon l'état de Tailscale
 * lu par le serveur : installer → connecter → publier → prêt.
 */
async function renderMobile(etat) {
  if (!surLePC) return;
  const m = etat || await getJSON('/api/mobile');
  if (!m) return;
  $('#mobileBox').hidden = false;
  $('#toujoursActif').checked = Boolean(m.toujoursActif);
  const t = m.tailscale || { etape: 'installer' };
  const verifier = '<button class="btn small" data-mobile="verifier">J\'ai fini, vérifier</button>';
  let html = '';
  if (t.etape === 'installer') {
    html = `<ol class="steps">
      <li>Installe <a href="https://tailscale.com/download/windows" target="_blank" rel="noopener">Tailscale sur ce PC</a> (gratuit) et connecte-toi, par exemple avec ton compte Google.</li>
      <li>Installe <a href="https://apps.apple.com/app/tailscale/id1470499037" target="_blank" rel="noopener">Tailscale sur l'iPhone</a> (App Store), avec le même compte.</li>
    </ol>${verifier}`;
  } else if (t.etape === 'connecter') {
    html = `<p class="hint">Tailscale est installé mais pas connecté : ouvre-le (icône près de l'horloge) et connecte-toi.</p>${verifier}`;
  } else if (t.etape === 'publier') {
    html = `<p class="hint">Tailscale est prêt. Dernière étape : rendre l'app joignable par tes appareils, et eux seuls.</p>
      <button class="btn small" data-mobile="publier">Activer l'accès iPhone</button>`;
  } else {
    const tel = (t.telephones || [])[0];
    html = `<p class="hint">Sur ton iPhone, ouvre cette adresse dans <strong>Safari</strong>, puis
      Partager › <strong>Sur l'écran d'accueil</strong> :</p>
      <div class="origin mobile-url"><span>${esc(t.adresse)}</span><button class="btn ghost small" data-mobile="copier">Copier</button></div>
      ${tel ? `<p class="hint">${esc(tel.nom)} : ${tel.enLigne ? 'connecté' : 'hors ligne pour le moment'}</p>` : ''}
      ${(m.appareils || []).filter((a) => a.via === 'tailscale').map((a) => {
        const min = Math.round((Date.now() - a.at) / 60000);
        const quand = min < 1 ? "à l'instant" : min < 60 ? `il y a ${min} min` : `il y a ${Math.round(min / 60)} h`;
        return `<p class="hint${a.version === 'a jour' ? '' : ' error'}">${esc(a.nom)} : dernière synchro ${quand}, ${a.version === 'a jour'
          ? 'version à jour'
          : "ancienne version de l'app : ferme-la complètement sur le téléphone (glisse-la vers le haut) puis rouvre-la"}</p>`;
      }).join('')}`;
  }
  $('#mobileSteps').innerHTML = html;
  $('#mobileHint').classList.remove('error');
  $('#mobileHint').textContent = m.toujoursActif
    ? 'Le serveur reste allumé et se met à jour tout seul, même fenêtre fermée. Si le PC est en veille, l\'iPhone affiche la dernière copie.'
    : 'Conseillé pour l\'iPhone : sinon le serveur s\'arrête 30 min après la fermeture de l\'app sur le PC.';
}

async function actionMobile(corps) {
  const hint = $('#mobileHint');
  hint.classList.remove('error');
  hint.textContent = 'Un instant…';
  try {
    const res = await fetch('/api/mobile', { method: 'POST', body: JSON.stringify(corps) });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'échec');
    await renderMobile(r);
  } catch (err) {
    hint.classList.add('error');
    // Le message peut contenir le lien d'activation HTTPS de Tailscale : on le rend cliquable.
    const lien = (err.message.match(/https:\/\/\S+/) || [])[0];
    hint.innerHTML = esc(err.message.replace(lien || '', '')) + (lien ? ` <a href="${esc(lien)}" target="_blank" rel="noopener">ouvrir la page Tailscale</a>, puis réessaie.` : '');
  }
}

$('#toujoursActif').addEventListener('change', (e) => actionMobile({ toujoursActif: e.target.checked }));
$('#mobileSteps').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-mobile]');
  if (!b) return;
  if (b.dataset.mobile === 'verifier') renderMobile();
  else if (b.dataset.mobile === 'publier') actionMobile({ publier: true });
  else if (b.dataset.mobile === 'copier') {
    const url = b.parentElement.querySelector('span').textContent;
    try { await navigator.clipboard.writeText(url); b.textContent = 'Copiée'; } catch { /* presse-papiers refusé */ }
  }
});
renderMobile().catch(() => {});

/* ------------------------------------------------------------ hors ligne */

/**
 * Service worker : garde les séances, l'app et les affiches pour un usage sans
 * réseau (iPhone dans le métro, PC éteint). Les navigateurs ne l'acceptent
 * qu'en HTTPS ou sur localhost — c'est le cas via Tailscale.
 */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* pas bloquant */ });
  // La date de la copie n'est connue qu'une fois l'index chargé : on attend un peu.
  const afficherHorsLigne = () => {
    if (!state.horsLigne) return;
    const quand = state.index?.generatedAt ? new Date(state.index.generatedAt) : null;
    const date = quand
      ? `le ${quand.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} à ${quand.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }).replace(':', 'h')}`
      : 'lors de la dernière connexion';
    setStatus('offline', `Hors ligne — séances récupérées ${date}. Elles se mettent à jour dès que ton PC est joignable.`);
  };
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'cine-maj') {
      majDispo = true;
      verifierVersion();
      return;
    }
    if (e.data?.type !== 'cine-reseau') return;
    if (e.data.horsLigne && !state.horsLigne) {
      state.horsLigne = true;
      setTimeout(afficherHorsLigne, 1200);
    } else if (!e.data.horsLigne && state.horsLigne) {
      state.horsLigne = false;
      hideStatus();
      softRefresh().catch(() => {}); // le PC répond de nouveau : on reprend les séances à jour
    }
  });
  // Sans cet appel, les messages du service worker restent en attente.
  navigator.serviceWorker.startMessages();
}

/**
 * Charge d'avance toutes les journées : le service worker en garde une copie,
 * pour pouvoir changer de jour même sans réseau.
 */
async function prechargerJours() {
  for (const d of state.index?.days || []) await loadDay(d.date);
  renderCart(); // toutes les journées connues : les séances gardées peuvent être contrôlées
}

state.cartKeys = new Set(state.cart.map(cartKey));
renderCart();

// Une mise à jour peut démarrer sans passer par cette page : lancée en ligne de
// commande, ou par le serveur à son démarrage. On vérifie régulièrement pour que
// la barre d'état dise toujours la vérité.
// (Rien quand l'app n'est pas à l'écran : ni réseau ni batterie pour rien.)
setInterval(() => { if (!watching && !document.hidden) watchRefresh(); }, 20000);

// Le marque-page peut pousser une watchlist pendant que l'app est ouverte :
// on la reprend sans attendre un rechargement.
setInterval(() => { if (!document.hidden) recupererWatchlistPoussee().catch(() => {}); }, 15000);

/**
 * Raccourcis clavier : « / » va à la recherche (comme sur la plupart des
 * sites), Échap ferme le panier ou, dans la recherche, la vide.
 */
addEventListener('keydown', (e) => {
  const enSaisie = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
  if (e.key === '/' && !enSaisie && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    $('#q').focus();
    $('#q').select();
  } else if (e.key === 'Escape') {
    if (uiDepth > 0) {
      history.back(); // un écran à la fois : on revient à celui d'en dessous
    } else if (document.activeElement === $('#q') && $('#q').value) {
      $('#q').value = '';
      $('#q').dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
});

/**
 * Panneau des filtres : il reste fixe à l'écran pendant qu'on fait défiler les
 * séances, avec son propre défilement. Sa position et sa hauteur dépendent de
 * la hauteur réelle de l'en-tête (barre des dates qui passe sur deux lignes,
 * barre d'état bleue affichée ou non) : on les calcule au lieu de les deviner,
 * sinon le bas du panneau sortait de l'écran ou son haut passait sous la barre.
 */
function fitFilters() {
  const f = $('#filters');
  const topbar = document.querySelector('.topbar');
  const status = $('#status');
  // + la bande de pellicule dessinée sous la barre (pseudo-élément ::after)
  const strip = parseFloat(getComputedStyle(topbar, '::after').height) || 0;
  const barH = topbar.getBoundingClientRect().height + strip;
  status.style.top = `${Math.round(barH)}px`;
  document.documentElement.style.setProperty('--head-h', `${Math.round(barH)}px`);
  if (getComputedStyle(f).position !== 'sticky') {
    f.style.maxHeight = '';
    return;
  }
  const head = barH + (status.hidden ? 0 : status.getBoundingClientRect().height);
  const top = Math.round(head + 12);
  f.style.top = `${top}px`;
  const visibleTop = Math.max(top, f.getBoundingClientRect().top);
  f.style.maxHeight = `${Math.max(200, Math.floor(innerHeight - visibleTop - 12))}px`;
}
let fitQueued = false;
const queueFit = () => {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => { fitQueued = false; fitFilters(); });
};
addEventListener('scroll', queueFit, { passive: true });
addEventListener('resize', queueFit);
new ResizeObserver(queueFit).observe(document.querySelector('.topbar'));
new ResizeObserver(queueFit).observe($('#status'));
queueFit();

/* ------------------------------------------------- synchro PC <-> téléphone */

/**
 * Séances gardées, favoris et liste « à voir » vivent sur le serveur du PC :
 * enregistrer une séance sur l'iPhone la fait apparaître sur le PC, et
 * inversement. Chaque appareil retient la liste de sa dernière synchro (la
 * base) : seuls ses vrais ajouts et retraits depuis sont rejoués sur la liste
 * commune. Deux appareils qui changent la même liste, hors ligne ou non, ne
 * s'écrasent donc plus, et les horloges n'ont aucun rôle.
 */
// Déclaration « hoistée » : save() peut appeler noterPerso() à tout moment.
var persoTimer = null;
function noterPerso() {
  clearTimeout(persoTimer);
  persoTimer = setTimeout(() => syncPerso().catch(() => {}), 400);
}

const valeurLocale = {
  cart: () => state.cart,
  favs: () => [...state.favs],
  wlLocal: () => [...state.wlLocal],
  wlPerso: () => state.wlPerso,
};
const clePerso = {
  cart: cartKey,
  favs: (x) => String(x),
  wlLocal: (x) => String(x),
  wlPerso: (x) => `${String(x?.title || '').toLowerCase()}|${x?.year || ''}`,
};

/** Rejoue sur `commun` ce qui a changé entre `base` et `moi` (même règle que le serveur). */
function fusionTrois(commun, moi, base, cleDe) {
  const clesMoi = new Set(moi.map(cleDe));
  const clesBase = new Set(base.map(cleDe));
  const garde = commun.filter((x) => clesMoi.has(cleDe(x)) || !clesBase.has(cleDe(x)));
  const presents = new Set(garde.map(cleDe));
  for (const x of moi) {
    if (!clesBase.has(cleDe(x)) && !presents.has(cleDe(x))) { garde.push(x); presents.add(cleDe(x)); }
  }
  return garde;
}
const memesElements = (a, b, cleDe) => {
  if (a.length !== b.length) return false;
  const k = new Set(a.map(cleDe));
  return b.every((x) => k.has(cleDe(x)));
};

function appliquerPerso(cle, v) {
  appliquantPerso = true;
  try {
    if (cle === 'cart') {
      state.cart = v;
      state.cartKeys = new Set(v.map(cartKey));
      save('cineidf.cart', v);
    } else if (cle === 'favs') {
      state.favs = new Set(v);
      save('cineidf.favs', v);
    } else if (cle === 'wlLocal') {
      state.wlLocal = new Set(v.map(String));
      save('cineidf.wlLocal', [...state.wlLocal]);
    } else if (cle === 'wlPerso') {
      state.wlPerso = v;
      save('cineidf.wlPerso', v);
    }
  } finally {
    appliquantPerso = false;
  }
}

let persoEnCours = false;
// Où en est la synchro, affiché dans « Mes séances » : sans ça, une synchro qui
// échoue ne se voit pas.
const synchro = { ok: Number(localStorage.getItem('cineidf.synchroOk')) || 0, erreur: '' };
async function syncPerso() {
  if (persoEnCours) return;
  persoEnCours = true;
  let encore = false;
  // L'iPhone peut geler une requête en mettant l'app en veille, et elle ne
  // revient jamais : sans délai maximum, plus aucune synchro ne repartait.
  const arret = new AbortController();
  const minuterie = setTimeout(() => arret.abort(), 12000);
  try {
    const base = load('cineidf.persoBase', {});
    const envoi = {};
    for (const cle of Object.keys(valeurLocale)) {
      // Jamais synchronisé sur cet appareil : base vide, tout son contenu est ajouté.
      envoi[cle] = { v: valeurLocale[cle](), base: base[cle] || [] };
    }
    const res = await fetch('/api/perso', { method: 'POST', body: JSON.stringify(envoi), signal: arret.signal });
    if (!res.ok) {
      synchro.erreur = `le PC a répondu « erreur ${res.status} »`;
      return;
    }
    const serveur = await res.json();
    synchro.ok = Date.now();
    synchro.erreur = '';
    localStorage.setItem('cineidf.synchroOk', String(synchro.ok));
    let change = false;
    for (const cle of Object.keys(valeurLocale)) {
      const commun = serveur[cle]?.v;
      if (!Array.isArray(commun)) continue;
      const local = valeurLocale[cle]();
      // Ce qui a changé ici pendant l'aller-retour est gardé, et repartira ensuite.
      const final = fusionTrois(commun, local, envoi[cle].v, clePerso[cle]);
      if (!memesElements(final, local, clePerso[cle])) { appliquerPerso(cle, final); change = true; }
      if (!memesElements(final, commun, clePerso[cle])) encore = true;
      base[cle] = commun;
    }
    localStorage.setItem('cineidf.persoBase', JSON.stringify(base));
    if (change) {
      renderCart();
      if (state.day) {
        state.wlHits = watchlistMatches(state.day);
        renderWatchlist();
        renderPerso();
        render();
        syncChips();
      }
    }
  } catch {
    synchro.erreur = 'PC injoignable'; // hors ligne : on réessaiera
  } finally {
    clearTimeout(minuterie);
    persoEnCours = false;
    afficherSynchro();
    if (encore) noterPerso();
  }
}

function afficherSynchro() {
  const el = $('#cartSync');
  if (!el) return;
  const heure = synchro.ok ? new Date(synchro.ok).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }).replace(':', 'h') : '';
  const jour = synchro.ok && new Date(synchro.ok).toDateString() !== new Date().toDateString()
    ? ` le ${new Date(synchro.ok).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}` : '';
  el.classList.toggle('error', Boolean(synchro.erreur));
  el.innerHTML = synchro.erreur
    ? `Pas synchronisé : ${esc(synchro.erreur)}${heure ? ` (dernière fois${jour} à ${heure})` : ''}. Tes séances partiront dès qu'il répond. <button class="linklike" data-sync-now>Réessayer</button>`
    : synchro.ok ? `Synchronisé avec le PC${jour} à ${heure}` : 'Synchronisation avec le PC…';
}
setInterval(() => { if (!document.hidden) syncPerso(); }, 15000);
addEventListener('focus', () => { syncPerso(); verifierVersion(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { syncPerso(); auRetour(); verifierVersion(); } });

/**
 * L'iPhone garde l'app en mémoire : au retour, elle peut dater d'hier. On passe à
 * la journée en cours si besoin, on retire les séances passées, on reprend les
 * séances à jour.
 */
async function auRetour() {
  if (!state.index) return;
  await softRefresh();
  const auj = todayStr();
  if (state.date < auj && state.index.days.some((d) => d.date === auj)) await selectDate(auj);
  else render();
  await passerSiJourneeFinie();
  renderCart();
}

/**
 * Pour la même raison, l'app peut garder une vieille version en mémoire. Au
 * retour, si les fichiers ont changé et que rien n'est en cours, on recharge.
 */
let versionChargee = null;
async function verifierVersion() {
  const r = await getJSON('/api/version');
  if (!r?.version) return;
  versionChargee ??= r.version;
  const occupe = state.filmOpen != null || state.panel || document.activeElement === $('#q');
  if ((r.version !== versionChargee || majDispo) && !occupe) location.reload();
  // Le service worker se met à jour lui aussi, sans attendre la prochaine ouverture.
  navigator.serviceWorker?.getRegistration().then((reg) => reg?.update()).catch(() => {});
}
// Le service worker prévient quand il a servi une vieille copie de l'app et
// qu'une plus récente est arrivée entre-temps (réseau lent).
var majDispo = false;
verifierVersion();
setInterval(() => { if (!document.hidden) verifierVersion(); }, 60000);

boot().then(() => syncPerso()).catch(() => {});
