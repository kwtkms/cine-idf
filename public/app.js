'use strict';

const DEPTS = [
  ['75', 'Paris'], ['77', 'Seine-et-Marne'], ['78', 'Yvelines'], ['91', 'Essonne'],
  ['92', 'Hauts-de-Seine'], ['93', 'Seine-Saint-Denis'], ['94', 'Val-de-Marne'], ['95', "Val-d'Oise"],
];
const PAGE = 40;

const $ = (sel) => document.querySelector(sel);
const load = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

const state = {
  index: null,
  theaters: [],
  byId: new Map(),
  date: null,
  day: null,
  view: load('cineidf.view', 'films'),
  sort: load('cineidf.sort', 'popular'),
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
  cartOpen: false,
  wlHits: new Set(),                           // ids des films du jour présents dedans
  filters: Object.assign(
    { q: '', depts: [], city: '', theater: '', version: '', from: '', to: '', genre: '', onlyFav: false, hidePast: true, hidePreview: false, radius: '', onlyWatchlist: false, ugcOnly: true },
    load('cineidf.filters', {}),
  ),
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------------------------------------------------- recherche floue */

// Sans accents, sans ponctuation : "Panthéon" et "pantheon" doivent se valoir.
const norm = (s) => String(s ?? '')
  .normalize('NFD').replace(/\p{Mn}/gu, '') // marques diacritiques décomposées
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Distance d'édition bornée (Levenshtein avec sortie anticipée). */
function withinEdit(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return false;
    prev = cur;
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
  const q = norm(state.filters.q);
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
      movies.set(m.id, tokenMask(norm(hay), tokens));
    }
    for (const t of state.theaters) {
      theaters.set(t.id, tokenMask(norm(`${t.name} ${t.city} ${t.address}`), tokens));
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
    d: date, t: show.t, m: show.m, s: show.s, v: show.v, u: show.u || null,
    titre: m?.title ?? '', salle: t?.name ?? '', ville: t?.city ?? '',
  };
  const k = cartKey(item);

  if (state.cartKeys.has(k)) state.cart = state.cart.filter((x) => cartKey(x) !== k);
  else state.cart = [...state.cart, item];

  state.cartKeys = new Set(state.cart.map(cartKey));
  save('cineidf.cart', state.cart);
  renderCart();
}

/** Chronologique : date puis heure. */
const cartSorted = () => [...state.cart].sort((a, b) => a.d.localeCompare(b.d) || slot(a.s) - slot(b.s));

function renderCart() {
  const n = state.cart.length;
  $('#cartCount').textContent = n;
  $('#cartFab').hidden = n === 0;
  if (!n) { $('#cart').hidden = true; state.cartOpen = false; }

  const jours = new Set(state.cart.map((x) => x.d)).size;
  $('#cartSummary').textContent = n ? `${plural(n, 'séance')} · ${plural(jours, 'jour')}` : '';

  const parJour = new Map();
  for (const x of cartSorted()) {
    if (!parJour.has(x.d)) parJour.set(x.d, []);
    parJour.get(x.d).push(x);
  }

  $('#cartBody').innerHTML = [...parJour.entries()].map(([date, items]) => {
    const [label, num] = fmtDate(date);
    return `<div class="cart-day">
      <button class="cart-date" data-cart-date="${date}">${esc(label)} ${esc(num)}</button>
      ${items.map((x) => `<div class="cart-item">
        <div class="cart-when">${esc(x.s)}<em>${esc(x.v)}</em></div>
        <div class="cart-what">
          <div class="cart-title">${esc(x.titre)}</div>
          <div class="muted small">${esc(x.salle)}${x.ville ? ` · ${esc(x.ville)}` : ''}</div>
        </div>
        ${x.u ? `<a class="btn ghost small" href="${esc(x.u)}" target="_blank" rel="noopener">Réserver</a>` : ''}
        <button class="fav" data-cart-del="${esc(cartKey(x))}" title="Retirer">✕</button>
      </div>`).join('')}
    </div>`;
  }).join('');
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
// Date LOCALE (format suédois = AAAA-MM-JJ). toISOString donnait la date UTC :
// entre minuit et 2 h, l'app se croyait encore la veille.
const todayStr = () => new Date().toLocaleDateString('sv');
const nowHHMM = () => new Date().toTimeString().slice(0, 5);

function fmtDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  const day = d.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '');
  const num = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }).replace('.', '');
  if (iso === todayStr()) return ["aujourd'hui", num];
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
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
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

  // Un export Letterboxd frais dans Téléchargements ? On le reprend sans rien demander.
  if (lireWatchlistDansAdresse()) {
    state.wlHits = watchlistMatches(state.day);
    renderWatchlist();
    render();
    setStatus('ok', `Watchlist reçue depuis Letterboxd — ${plural(state.watchlist.length, 'film')}, ${state.wlHits.size} à l'affiche`, { autoHide: 8000 });
  }

  recupererWatchlistPoussee()
    .then((recue) => (recue ? null : detecterExportLetterboxd()))
    .then(() => rappelerWatchlist())
    .catch(() => {});
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
  state.date = date;
  state.limit = PAGE;
  state.expanded = new Set();
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

  $('#meta').textContent = metaText();
}

function buildStaticFilters() {
  const f = state.filters;

  $('#depts').innerHTML = DEPTS.map(
    ([code, name]) => `<button class="chip ${f.depts.includes(code) ? 'active' : ''}" data-dept="${code}" title="${esc(name)}">${code}</button>`,
  ).join('');

  $('#q').value = f.q;
  $('#from').value = f.from;
  $('#to').value = f.to;
  $('#onlyFav').checked = f.onlyFav;
  $('#hidePast').checked = f.hidePast;
  $('#hidePreview').checked = f.hidePreview;
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

function timesHTML(shows) {
  const isToday = state.date === todayStr();
  const nowMin = slot(nowHHMM());
  const sorted = shows.slice().sort((a, b) => slot(a.s) - slot(b.s));
  // La première séance encore à venir de cette salle : c'est celle qu'on annote.
  const nextIndex = isToday ? sorted.findIndex((s) => slot(s.s) >= nowMin) : -1;

  return sorted
    .map((s, i) => {
      const mins = slot(s.s) - nowMin;
      const past = isToday && mins < 0;
      const soon = isToday && !past && mins <= 120;
      const kept = cartHas(state.date, s);
      const cls = `time${past ? ' past' : ''}${s.p ? ' preview' : ''}${s.x ? ' unconfirmed' : ''}${soon ? ' soon' : ''}${kept ? ' kept' : ''}`;
      const badge = i === nextIndex && mins <= 240 ? `<i class="in">${fmtIn(mins)}</i>` : '';
      // Un clic met la séance de côté ; la réservation se fait depuis le panier.
      return `<button class="${cls}" data-show="${esc(JSON.stringify({ t: s.t, m: s.m, s: s.s, v: s.v, u: s.u }))}"
        title="${chipTitle(kept, s.p, s.x)}">${s.s} <em>${s.v}${s.p ? ' · AP' : ''}${s.x ? ' ?' : ''}</em>${badge}</button>`;
    })
    .join('');
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

function movieCard(m, theaterMap, total, { full = false } = {}) {
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
  ].filter(Boolean).join('<span class="dot">·</span>');

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
      ${full ? `<div class="card-links">${m.url ? `<a class="btn ghost small" href="${esc(m.url)}" target="_blank" rel="noopener">Fiche AlloCiné</a>` : ''}<a class="btn ghost small" href="${esc(note?.url || `https://letterboxd.com/search/films/${encodeURIComponent(m.originalTitle || m.title)}/`)}" target="_blank" rel="noopener">Letterboxd</a></div>` : ''}
      ${shown.map((r) => `<div class="group">
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

function theaterCard(t, movieMap, total, { full = false } = {}) {
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
  const itineraire = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${t.name} ${t.address}`)}`;

  return `<article class="card cine">
    <div class="card-body">
      <h3 class="card-title">
        ${favBtn(t.id)}
        <a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.name)}</a>
        <span class="group-sub">${plural(total, 'séance')} · ${plural(rows.length, 'film')}</span>
      </h3>
      <div class="card-meta">${esc(t.address)}${state.origin ? `<span class="dot">·</span>${fmtKm(distanceTo(t))}` : ''}</div>
      ${full ? `<div class="card-links"><a class="btn small" href="${esc(itineraire)}" target="_blank" rel="noopener">Itinéraire</a><a class="btn ghost small" href="${esc(t.url)}" target="_blank" rel="noopener">Page AlloCiné</a></div>` : ''}
      ${shown.map((r) => `<div class="group">
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
  const jour = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const tard = isToday && new Date().getHours() >= 17;
  $('#dayTitle').textContent = isToday ? (tard ? 'Ce soir' : "Aujourd'hui") : jour.charAt(0).toUpperCase() + jour.slice(1);
  $('#dayKicker').textContent = isToday ? jour : '';
  $('#dayKicker').hidden = !isToday;

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
  const infos = [
    Number.isFinite(premiere) ? (state.date === todayStr() ? `prochaine à ${fmtSlot(premiere)}` : `dès ${fmtSlot(premiere)}`) : '',
    plural(theaterMap.size, 'cinéma'),
  ].filter(Boolean).join(' · ');
  return `<button class="film-tile" data-film="${m.id}" title="Voir les cinémas et les horaires">
    <span class="tile-poster">
      ${vignette ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(vignette)}" alt="">` : `<span class="tile-noposter">${esc(m.title)}</span>`}
      ${vu ? '<span class="tile-badge">à voir</span>' : ''}
      ${note ? `<span class="tile-note ${note.source === 'Letterboxd' ? 'lb' : 'ac'}">★ ${note.valeur.toFixed(1).replace('.', ',')}</span>` : ''}
    </span>
    <span class="tile-title">${esc(m.title)}</span>
    <span class="tile-info">${esc(infos)}</span>
  </button>`;
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

/** Ouvre (ou ferme avec null) le panneau d'un film. */
function openFilm(id, kind = 'film') {
  state.filmOpen = id;
  state.sheetKind = kind;
  $('#filmSheet').hidden = id == null;
  document.body.classList.toggle('sheet-open', id != null);
  if (id != null) {
    renderFilmSheet();
    $('#filmSheetPanel').scrollTop = 0;
    $('#filmSheetClose').focus({ preventScroll: true });
  }
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
    $('#filmSheetBody').innerHTML = jours + theaterCard(t, byMovie, shows.length, { full: true });
  } else {
    const byTheater = groupBy(shows, (x) => x.m, (x) => x.t).get(m.id) || new Map();
    $('#filmSheetBody').innerHTML = jours + movieCard(m, byTheater, shows.length, { full: true });
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
}

function render() {
  if (!state.day) return;
  state.expanded ||= new Set();

  const shows = filteredShows();
  const grouped = state.view === 'films'
    ? groupBy(shows, (s) => s.m, (s) => s.t)
    : groupBy(shows, (s) => s.t, (s) => s.m);

  const entries = sortEntries([...grouped.entries()], state.view);

  $('#count').textContent = shows.length
    ? `${plural(shows.length, 'séance')} · ${plural(entries.length, state.view === 'films' ? 'film' : 'cinéma')}`
    : '';
  renderHero(shows, entries);
  renderWlWeek().catch(() => {});

  if (!entries.length) {
    const [, num] = fmtDate(state.date);
    const info = state.index.days.find((d) => d.date === state.date);
    const loading = info && info.complete === false;
    const muet = state.filters.theater && silentTheaters().find((t) => t.id === state.filters.theater);
    $('#results').innerHTML = sparseNotice() + (muet
      ? `<p class="notice">${esc(muet.name)} ne publie aucun horaire en ligne (ni sur AlloCiné, ni ailleurs) : appelle la salle pour connaître ses séances.</p>`
      : '') + `<div class="empty" id="emptyBox">
      <h2>${loading ? `Récupération en cours` : `Aucune séance le ${esc(num)}`}</h2>
      <p>${loading
        ? `${info.theatersScanned}/${info.theatersTotal} salles récupérées pour le ${esc(num)}. Les séances apparaissent au fur et à mesure.`
        : `Essaie d'élargir les filtres ou de changer de date.`}</p>
      ${state.filters.q.trim() ? `<p class="muted small" id="crossDate">Recherche sur les autres dates…</p>` : ''}
    </div>`;
    if (state.filters.q.trim()) suggestOtherDates();
    renderFilmSheet();
    return;
  }

  const slice = entries.slice(0, state.limit);
  const items = slice.map(([key, sub]) => {
    const total = [...sub.values()].reduce((n, a) => n + a.length, 0);
    return state.view === 'films'
      ? filmTile(state.day.movies[key], sub, total)
      : theaterTile(state.byId.get(key), sub, total);
  }).join('');
  const html = `<div class="${state.view === 'films' ? 'film-grid' : 'cine-grid'}">${items}</div>`;
  renderFilmSheet();

  $('#results').innerHTML = sparseNotice() + html +
    (entries.length > state.limit ? `<button class="btn ghost" id="loadMore">Afficher ${Math.min(PAGE, entries.length - state.limit)} de plus (${entries.length - state.limit} restants)</button>` : '');
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

let favsSent = '';
function persist() {
  save('cineidf.filters', state.filters);
  save('cineidf.view', state.view);
  save('cineidf.sort', state.sort);
  save('cineidf.favs', [...state.favs]);

  // Le scraper lit cette liste pour commencer par tes salles.
  const ids = JSON.stringify([...state.favs]);
  if (ids !== favsSent) {
    favsSent = ids;
    fetch('/api/favorites', { method: 'POST', body: ids }).catch(() => {});
  }
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

$('#view').addEventListener('click', (e) => {
  openFilm(null);
  const b = e.target.closest('[data-view]');
  if (!b) return;
  state.view = b.dataset.view;
  for (const x of document.querySelectorAll('#view .chip')) x.classList.toggle('active', x === b);
  onFilterChange();
});

let timer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(timer);
  const v = e.target.value;
  timer = setTimeout(() => { state.filters.q = v; onFilterChange(); }, 180);
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
for (const [id, key] of [['onlyFav', 'onlyFav'], ['hidePast', 'hidePast'], ['hidePreview', 'hidePreview']]) {
  $(`#${id}`).addEventListener('change', (e) => { state.filters[key] = e.target.checked; onFilterChange(); });
}

$('#reset').addEventListener('click', () => {
  state.filters = { q: '', depts: [], city: '', theater: '', version: '', from: '', to: '', genre: '', onlyFav: false, hidePast: true, hidePreview: false, radius: '', onlyWatchlist: false, ugcOnly: true };
  buildStaticFilters();
  buildGenres();
  onFilterChange();
});

$('#filtersToggle').addEventListener('click', () => $('#filters').classList.toggle('open'));

/* ---------------------------------------------------------- panier (UI) */

$('#cartFab').addEventListener('click', () => {
  state.cartOpen = !state.cartOpen;
  $('#cart').hidden = !state.cartOpen;
});
$('#cartClose').addEventListener('click', () => { state.cartOpen = false; $('#cart').hidden = true; });

/** Remet les pastilles visibles en accord avec le panier, sans tout redessiner. */
function syncChips() {
  for (const chip of document.querySelectorAll('#results [data-show]')) {
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
  // Cliquer la date du groupe ramène à cette journée dans la liste.
  const jour = e.target.closest('[data-cart-date]');
  if (jour && jour.dataset.cartDate !== state.date) selectDate(jour.dataset.cartDate);
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
  if (state.view !== 'films') {
    state.view = 'films';
    for (const x of document.querySelectorAll('#view .chip')) x.classList.toggle('active', x.dataset.view === 'films');
  }
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

$('#locate').addEventListener('click', () => {
  if (!navigator.geolocation) return alert("La géolocalisation n'est pas disponible.");
  $('#locate').textContent = '⏳ …';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $('#locate').textContent = '📍 Ma position';
      setOrigin({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Ma position' });
    },
    () => {
      $('#locate').textContent = '📍 Ma position';
      alert("Position refusée ou indisponible. Tu peux saisir une adresse à la place.");
    },
    { enableHighAccuracy: true, timeout: 10000 },
  );
});

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
  const tile = e.target.closest('[data-film]');
  if (tile) return openFilm(tile.dataset.film, 'film');
  const cineTile = e.target.closest('[data-cine]');
  if (cineTile) return openFilm(cineTile.dataset.cine, 'theater');

  const jump = e.target.closest('[data-date]');
  if (jump) return selectDate(jump.dataset.date);

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
  const exp = e.target.closest('[data-expand]');
  if (exp) {
    const k = exp.dataset.expand;
    state.expanded.has(k) ? state.expanded.delete(k) : state.expanded.add(k);
    render();
    return;
  }
  if (e.target.id === 'loadMore') {
    state.limit += PAGE;
    render();
  }
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
  const gen = new Date(state.index.generatedAt);
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
  state.index = index;

  // Toutes les journées ont pu changer, pas seulement celle affichée — et les
  // notes Letterboxd sont complétées à la fin de chaque mise à jour.
  dayCache.clear();
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

state.cartKeys = new Set(state.cart.map(cartKey));
renderCart();

// Une mise à jour peut démarrer sans passer par cette page : lancée en ligne de
// commande, ou par le serveur à son démarrage. On vérifie régulièrement pour que
// la barre d'état dise toujours la vérité.
setInterval(() => { if (!watching) watchRefresh(); }, 20000);

// Le marque-page peut pousser une watchlist pendant que l'app est ouverte :
// on la reprend sans attendre un rechargement.
setInterval(() => { recupererWatchlistPoussee().catch(() => {}); }, 15000);

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
    if (!$('#filmSheet').hidden) {
      openFilm(null);
    } else if (!$('#cart').hidden) {
      state.cartOpen = false;
      $('#cart').hidden = true;
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

boot();
