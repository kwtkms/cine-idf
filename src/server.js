// Petit serveur local : sert l'interface + les fichiers de data/, et permet de
// relancer la recuperation depuis le navigateur. Zero dependance.

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { trouverExport, lireWatchlist } from './import-watchlist.js';
import { staleDays } from './freshness.js';
import { syncWatchlist, etatSync, definirPseudo, pseudoValide } from './letterboxd-watchlist.js';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const refresh = {
  running: false,
  startedAt: null,
  log: [],
  code: null,
  progress: null,  // { date, day, days, done, total, shows }
  summary: null,   // { days, shows, theaters, partial }
  error: null,     // { kind, message }
};

// Resultat de la derniere mise a jour, conserve sur disque : l'app peut signaler
// un echec meme apres un redemarrage du serveur.
const LAST_FILE = () => path.join(DATA, 'last-refresh.json');
function loadLast() {
  try {
    return readJsonSync(LAST_FILE());
  } catch {
    return null;
  }
}
function saveLast(entry) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(LAST_FILE(), JSON.stringify(entry, null, 1));
  } catch { /* pas bloquant */ }
}

// JSON.parse echoue sur un BOM UTF-8 : un fichier de data/ reecrit par un autre
// outil deviendrait invisible pour l'app.
function readJsonSync(file) {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function send(req, res, status, body, type = 'application/json; charset=utf-8') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    const gz = zlib.gzipSync(buf);
    res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
    return res.end(gz);
  }
  res.writeHead(status, { ...headers, 'Content-Length': buf.length });
  res.end(buf);
}

async function sendFile(req, res, file) {
  try {
    const buf = await fsp.readFile(file);
    send(req, res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  } catch {
    send(req, res, 404, JSON.stringify({ error: 'not found' }));
  }
}

/**
 * L'index est construit depuis les fichiers presents dans data/, pas depuis
 * index.json : une journee recuperee pendant qu'un scrape tourne encore doit
 * etre consultable tout de suite. Cache invalide par la date de modification.
 */
let indexCache = { key: '', value: null };
function buildIndex() {
  if (!fs.existsSync(path.join(DATA, 'theaters.json'))) return null;

  const files = fs.readdirSync(DATA).filter((f) => /^day-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const today = new Date().toLocaleDateString('sv'); // YYYY-MM-DD local

  // La date fait partie de la cle : sinon, une app laissee ouverte toute la nuit
  // continuerait d'afficher la veille tant qu'aucun fichier ne change.
  const key = [today, ...files.map((f) => `${f}:${fs.statSync(path.join(DATA, f)).mtimeMs}`)].join('|');
  if (indexCache.key === key && indexCache.value) return indexCache.value;
  const days = [];
  let generatedAt = null;
  const scanned = new Set();
  const withShows = new Set();

  for (const f of files) {
    const date = f.slice(4, 14);
    if (date < today) continue; // journee passee : plus rien a en tirer
    try {
      const d = readJsonSync(path.join(DATA, f));
      if (!d.counts?.shows) continue; // pas encore de seances : on l'ignore
      days.push({ date, complete: Boolean(d.complete), ...d.counts });
      for (const id of d.scanned || []) scanned.add(id);
      for (const sh of d.shows) withShows.add(sh.t);
      if (!generatedAt || d.fetchedAt > generatedAt) generatedAt = d.fetchedAt;
    } catch { /* fichier en cours d'ecriture : on reessaiera */ }
  }
  if (!days.length) return null;

  let theaterCount = 0;
  try {
    theaterCount = readJsonSync(path.join(DATA, 'theaters.json')).theaters.length;
  } catch { /* liste illisible */ }

  const value = {
    generatedAt: generatedAt ?? new Date().toISOString(),
    theaterCount,
    partial: days.some((d) => !d.complete),
    days,
    // Salles interrogees chaque jour mais sans rien publie en ligne (ex. un
    // cinema qui ne diffuse ses horaires que par telephone ou sur papier).
    silent: days.length >= 3 ? [...scanned].filter((id) => !withShows.has(id)) : [],
  };
  indexCache = { key, value };
  return value;
}

/** Progression ecrite par un scrape lance hors du serveur. */
function readProgressFile() {
  try {
    const p = readJsonSync(path.join(DATA, 'progress.json'));
    return Date.now() - p.at < 120000 ? p : null; // trop vieux : plus significatif
  } catch {
    return null;
  }
}

function externalRefreshRunning() {
  try {
    const pid = Number(fs.readFileSync(path.join(DATA, '.refresh.lock'), 'utf8'));
    process.kill(pid, 0); // ne tue rien : teste seulement l'existence du process
    return true;
  } catch {
    return false;
  }
}

function startRefresh(days, { refetch = false } = {}) {
  if (refresh.running || externalRefreshRunning()) return false;
  refresh.running = true;
  refresh.startedAt = new Date().toISOString();
  refresh.log = [];
  refresh.code = null;

  const args = [path.join(ROOT, 'src', 'scrape.js'), `--days=${days}`, ...(refetch ? ['--refetch'] : [])];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true, // aucune fenetre de console ne doit apparaitre
  });
  const push = (chunk) => {
    for (const raw of chunk.toString().split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;

      // Lignes structurees emises par scrape.js (progression / fin / erreur).
      const marker = /^##([PDE]) (.+)$/.exec(line);
      if (marker) {
        try {
          const payload = JSON.parse(marker[2]);
          if (marker[1] === 'P') refresh.progress = payload;
          else if (marker[1] === 'D') refresh.summary = payload;
          else refresh.error = payload;
        } catch { /* ligne malformee : on l'ignore */ }
        continue;
      }
      refresh.log.push(line);
    }
    if (refresh.log.length > 400) refresh.log.splice(0, refresh.log.length - 400);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);

  child.on('close', (code, signal) => {
    refresh.running = false;
    refresh.code = code;
    if (code !== 0 && !refresh.error) {
      // Un processus tue renvoie un code exotique sous Windows (4294967295) :
      // inutile de l'afficher tel quel.
      const killed = signal || code === null || code > 255;
      if (code === 3) refresh.error = { kind: 'busy', message: 'Une autre mise à jour était déjà en cours.' };
      else if (killed) refresh.error = { kind: 'interrupted', message: 'La mise à jour a été interrompue (mise en veille, fermeture, ou arrêt manuel). Les données déjà récupérées sont conservées.' };
      else refresh.error = { kind: 'crash', message: `La mise à jour s'est arrêtée de façon inattendue (code ${code}). Voir les détails.` };
    }
    refresh.log.push(code === 0 ? '--- mise a jour terminee ---' : `--- echec (code ${code}) ---`);
    saveLast({
      at: new Date().toISOString(),
      code,
      error: refresh.error,
      summary: refresh.summary,
      tail: refresh.log.slice(-25),
    });
  });
  return true;
}

// Par defaut le serveur n'ecoute que sur la machine locale. HOST=0.0.0.0 l'ouvre
// au reseau local, pour consulter l'app depuis un telephone sur le meme wifi.
const HOST = process.env.HOST || '127.0.0.1';

// Seule origine externe acceptee, et uniquement pour le marque-page watchlist.
const ORIGINES_LETTERBOXD = new Set(['https://letterboxd.com', 'https://www.letterboxd.com']);

/**
 * Une page web quelconque ouverte dans le navigateur pourrait appeler ce
 * serveur : on refuse toute requete dont l'origine n'est pas la sienne. En mode
 * reseau local, l'origine legitime est l'adresse par laquelle on est joint,
 * d'ou la comparaison avec l'en-tete Host.
 */
function origineAcceptee(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // navigation normale : pas d'en-tete Origin
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// L'app est ouverte ponctuellement : le serveur ne doit pas rester en memoire
// jusqu'au redemarrage du PC.
//
// La presence de l'app est detectee par une connexion maintenue ouverte (SSE),
// et non par un battement en JavaScript : le navigateur gele les minuteries
// d'une fenetre en arriere-plan, alors que la connexion, elle, reste etablie.
// Fermer la fenetre ferme la socket, et le serveur s'arrete apres IDLE_MIN.
// Le raccourci du bureau le relance sans que ca se voie.
const IDLE_MIN = Number(process.env.IDLE_MIN || 30);
let lastRequestAt = Date.now();
const liveClients = new Set();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = url.pathname;

  // Le marque-page watchlist est la seule exception : il vient forcement de
  // letterboxd.com, et sa propre route revalide l'origine.
  if (!route.startsWith('/api/watchlist/push') && route !== '/api/watchlist/toggle' && !origineAcceptee(req)) {
    return send(req, res, 403, JSON.stringify({ error: 'origine refusee' }));
  }

  lastRequestAt = Date.now();
  if (route === '/api/ping') return send(req, res, 200, JSON.stringify({ ok: true }));

  // Connexion temoin : ouverte tant que l'app l'est.
  if (route === '/api/alive') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 5000\n\n');
    liveClients.add(res);
    const drop = () => liveClients.delete(res);
    req.on('close', drop);
    req.on('error', drop);
    return;
  }

  if (route === '/api/index') {
    const index = buildIndex();
    if (!index) return send(req, res, 404, JSON.stringify({ error: 'no-data' }));
    return send(req, res, 200, JSON.stringify(index));
  }

  // Notes Letterboxd, indexees par identifiant de film AlloCine.
  if (route === '/api/ratings') {
    const file = path.join(DATA, 'letterboxd.json');
    if (!fs.existsSync(file)) return send(req, res, 200, JSON.stringify({}));
    return sendFile(req, res, file);
  }

  if (route === '/api/theaters') {
    const file = path.join(DATA, 'theaters.json');
    if (!fs.existsSync(file)) return send(req, res, 404, JSON.stringify({ error: 'no-data' }));
    return sendFile(req, res, file);
  }

  const day = /^\/api\/day\/(\d{4}-\d{2}-\d{2})$/.exec(route);
  if (day) {
    const file = path.join(DATA, `day-${day[1]}.json`);
    if (!fs.existsSync(file)) return send(req, res, 404, JSON.stringify({ error: 'no-data' }));
    return sendFile(req, res, file);
  }

  // Relais vers la Base Adresse Nationale : permet de saisir une adresse de
  // depart sans avoir a autoriser la geolocalisation du navigateur.
  if (route === '/api/geocode') {
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 3) return send(req, res, 400, JSON.stringify({ error: 'requete trop courte' }));
    try {
      const api = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=20`;
      const upstream = await fetch(api, { signal: AbortSignal.timeout(15000) });
      const data = await upstream.json();

      const all = (data.features ?? []).map((f) => ({
        label: f.properties.label,
        postcode: f.properties.postcode || '',
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
      }));

      // Les parametres lat/lon de l'API ne suffisent pas a privilegier la region
      // ("chatelet" renvoie un hameau du Rhone). Toutes les salles etant en
      // Ile-de-France, on remonte explicitement les adresses franciliennes.
      const IDF = new Set(['75', '77', '78', '91', '92', '93', '94', '95']);
      const inIdf = (r) => IDF.has(r.postcode.slice(0, 2));
      const results = [...all.filter(inIdf), ...all.filter((r) => !inIdf(r))].slice(0, 6);

      return send(req, res, 200, JSON.stringify({ results }));
    } catch {
      return send(req, res, 502, JSON.stringify({ error: 'service adresse indisponible' }));
    }
  }




  // Ajout ou retrait d'un seul film, envoye par le script automatique quand tu
  // cliques le bouton watchlist sur une fiche Letterboxd.
  if (route === '/api/watchlist/toggle') {
    const origine = req.headers.origin || '';
    if (!ORIGINES_LETTERBOXD.has(origine)) {
      return send(req, res, 403, JSON.stringify({ error: 'origine non autorisee' }));
    }
    const cors = {
      'Access-Control-Allow-Origin': origine,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      'Access-Control-Allow-Private-Network': 'true',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 10000) break; }
    try {
      const { titre, annee, present } = JSON.parse(body);
      if (typeof titre !== 'string' || !titre.trim()) throw new Error('titre manquant');

      const f = path.join(DATA, 'watchlist.json');
      const actuel = fs.existsSync(f) ? readJsonSync(f) : { films: [], pseudo: null };
      const cle = (x) => `${String(x.title).toLowerCase()}|${x.year || ''}`;
      const film = { title: titre.trim().slice(0, 300), year: Number(annee) || null };

      let films = actuel.films.filter((x) => cle(x) !== cle(film));
      if (present) films = [film, ...films];

      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ ...actuel, recuLe: new Date().toISOString(), films }, null, 1));

      const corps = JSON.stringify({ films: films.length, action: present ? 'ajoute' : 'retire' });
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(corps);
    } catch (err) {
      res.writeHead(400, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Reception directe de la watchlist depuis letterboxd.com, via le marque-page.
  // C'est la seule route ouverte a une origine externe, et volontairement :
  // le contenu de la watchlist n'est lisible que depuis une page Letterboxd
  // ouverte dans TON navigateur, la ou le challenge Cloudflare est deja resolu.
  if (route === '/api/watchlist/push') {
    const origine = req.headers.origin || '';
    if (!ORIGINES_LETTERBOXD.has(origine)) {
      return send(req, res, 403, JSON.stringify({ error: 'origine non autorisee' }));
    }
    const cors = {
      'Access-Control-Allow-Origin': origine,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      // Chrome exige ceci pour qu'un site public joigne une adresse locale
      // (Private Network Access), sinon la requete est bloquee en amont.
      'Access-Control-Allow-Private-Network': 'true',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405, cors); return res.end(); }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 2_000_000) { res.writeHead(413, cors); return res.end(); }
    }
    try {
      const recu = JSON.parse(body);
      const films = (Array.isArray(recu) ? recu : recu.films ?? [])
        .filter((f) => f && typeof f.titre === 'string' && f.titre.trim())
        .map((f) => ({ title: f.titre.trim().slice(0, 300), year: Number(f.annee) || null }))
        .slice(0, 5000);
      if (!films.length) throw new Error('liste vide');

      const pseudo = typeof recu.pseudo === 'string' ? recu.pseudo.slice(0, 60) : null;
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(path.join(DATA, 'watchlist.json'),
        JSON.stringify({ recuLe: new Date().toISOString(), pseudo, films }, null, 1));

      const corps = JSON.stringify({ recus: films.length });
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(corps);
    } catch (err) {
      res.writeHead(400, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Synchro automatique de la watchlist Letterboxd : etat, pseudo, relance.
  if (route === '/api/watchlist/status') {
    return send(req, res, 200, JSON.stringify({ ...etatSync(), running: watchlistRunning }));
  }
  if (route === '/api/watchlist/user' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 2000) break; }
    let pseudo = null;
    try { pseudo = JSON.parse(body).pseudo; } catch { /* corps illisible */ }
    if (pseudo === null || pseudo === '') {
      definirPseudo(null);
      return send(req, res, 200, JSON.stringify(etatSync()));
    }
    if (!pseudoValide(pseudo)) return send(req, res, 400, JSON.stringify({ error: 'pseudo invalide' }));
    try {
      const r = await syncWatchlist(String(pseudo).trim());
      return send(req, res, 200, JSON.stringify(r));
    } catch (err) {
      return send(req, res, 400, JSON.stringify({ error: err.message }));
    }
  }
  if (route === '/api/watchlist/sync' && req.method === 'POST') {
    const r = await autoWatchlist({ force: true });
    return send(req, res, r?.ok === false ? 502 : 200, JSON.stringify(r ?? etatSync()));
  }

  // Watchlist recue par le marque-page, relue par l'app.
  if (route === '/api/watchlist/pushed') {
    const f = path.join(DATA, 'watchlist.json');
    if (!fs.existsSync(f)) return send(req, res, 200, JSON.stringify({ films: null }));
    return sendFile(req, res, f);
  }

  // Export Letterboxd depose dans le dossier Telechargements : l'app le detecte
  // et l'importe sans que tu aies a dezipper ni a chercher le fichier.
  if (route === '/api/watchlist/export') {
    const trouve = trouverExport();
    if (!trouve) return send(req, res, 200, JSON.stringify({ trouve: null }));
    return send(req, res, 200, JSON.stringify({
      trouve: { nom: trouve.nom, modifieLe: new Date(trouve.mtime).toISOString() },
    }));
  }

  if (route === '/api/watchlist/import' && req.method === 'POST') {
    const trouve = trouverExport();
    if (!trouve) return send(req, res, 404, JSON.stringify({ error: 'aucun export trouve' }));
    try {
      return send(req, res, 200, JSON.stringify({
        nom: trouve.nom,
        modifieLe: new Date(trouve.mtime).toISOString(),
        csv: lireWatchlist(trouve.chemin),
      }));
    } catch (err) {
      return send(req, res, 422, JSON.stringify({ error: err.message }));
    }
  }

  // Suppression du fichier, uniquement sur demande explicite et uniquement si
  // c'est bien l'export que l'on vient de detecter.
  if (route === '/api/watchlist/cleanup' && req.method === 'POST') {
    const trouve = trouverExport();
    if (!trouve) return send(req, res, 404, JSON.stringify({ error: 'aucun export trouve' }));
    try {
      fs.unlinkSync(trouve.chemin);
      return send(req, res, 200, JSON.stringify({ supprime: trouve.nom }));
    } catch (err) {
      return send(req, res, 500, JSON.stringify({ error: err.message }));
    }
  }

  // L'app publie ses favoris pour que la recuperation commence par eux : tes
  // salles sont a jour en quelques secondes au lieu de quelques minutes.
  if (route === '/api/favorites' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 20000) return send(req, res, 413, JSON.stringify({ error: 'trop long' }));
    }
    try {
      const ids = JSON.parse(body);
      if (!Array.isArray(ids)) throw new Error('format');
      const clean = ids.filter((x) => typeof x === 'string' && /^[A-Z0-9]{1,10}$/.test(x)).slice(0, 200);
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(path.join(DATA, 'favorites.json'), JSON.stringify(clean));
      return send(req, res, 200, JSON.stringify({ saved: clean.length }));
    } catch {
      return send(req, res, 400, JSON.stringify({ error: 'liste invalide' }));
    }
  }

  // Perimetre de recuperation : toutes les salles, ou seulement celles qui
  // acceptent la carte UGC Illimite.
  if (route === '/api/scope') {
    const file = path.join(DATA, 'scope.json');
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 1000) break; }
      try {
        const ugcOnly = JSON.parse(body).ugcOnly !== false;
        fs.mkdirSync(DATA, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ ugcOnly }, null, 1));
        return send(req, res, 200, JSON.stringify({ ugcOnly }));
      } catch {
        return send(req, res, 400, JSON.stringify({ error: 'reglage invalide' }));
      }
    }
    let ugcOnly = true;
    try { ugcOnly = readJsonSync(file).ugcOnly !== false; } catch { /* defaut */ }
    return send(req, res, 200, JSON.stringify({ ugcOnly }));
  }

  if (route === '/api/refresh' && req.method === 'POST') {
    const days = Math.max(1, Math.min(21, Number(url.searchParams.get('days')) || 5));
    refresh.error = null;
    refresh.summary = null;
    refresh.progress = null;
    // Demande explicite (bouton) : tout est relu, y compris les jours encore
    // frais. Les relances automatiques, elles, ne relisent que le perime.
    const started = startRefresh(days, { refetch: true });
    return send(req, res, started ? 202 : 409, JSON.stringify({ started, ...refresh }));
  }

  if (route === '/api/refresh') {
    // Un scrape peut aussi avoir ete lance en ligne de commande : le verrou le
    // signale, et sa progression est lue dans le fichier qu'il ecrit.
    const running = refresh.running || externalRefreshRunning();
    const external = !refresh.running && running;
    const progress = !running ? null : external ? readProgressFile() : refresh.progress;
    return send(req, res, 200, JSON.stringify({ ...refresh, running, external, progress, last: loadLast() }));
  }

  const file = path.join(PUBLIC, route === '/' ? 'index.html' : route.replace(/^\//, ''));
  if (!file.startsWith(PUBLIC)) return send(req, res, 403, JSON.stringify({ error: 'forbidden' }));
  return sendFile(req, res, file);
});

/**
 * Watchlist Letterboxd : relue a l'ouverture, puis toutes les 30 min tant que
 * l'app est ouverte. Quelques requetes vers Letterboxd (28 films par page),
 * jamais deux synchros en meme temps.
 */
let watchlistRunning = false;
async function autoWatchlist({ force = false } = {}) {
  const etat = etatSync();
  if (!etat.pseudo || watchlistRunning) return etat;
  const age = etat.at ? Date.now() - Date.parse(etat.at) : Infinity;
  if (!force && age < 30 * 60000) return etat;
  watchlistRunning = true;
  try {
    const r = await syncWatchlist(etat.pseudo);
    console.log(`Watchlist Letterboxd de ${r.pseudo} : ${r.count} films.`);
    return r;
  } catch (err) {
    console.log(`Watchlist Letterboxd non relue : ${err.message}`);
    return etatSync();
  } finally {
    watchlistRunning = false;
  }
}

/**
 * Lance une mise a jour si un jour est perime. Jamais plus d'une tentative
 * toutes les 15 min (une heure apres un echec) : un blocage Cloudflare ne doit
 * pas se transformer en boucle de relances.
 */
let lastAutoAt = 0;
function autoRefresh(motif) {
  if (refresh.running || externalRefreshRunning()) return;
  const pause = refresh.code != null && refresh.code !== 0 ? 3600000 : 900000;
  if (Date.now() - lastAutoAt < pause) return;
  const stale = staleDays(DATA, 5);
  if (!stale.length) return;
  lastAutoAt = Date.now();
  console.log(`Mise a jour automatique (${motif}) : ${stale.join(', ')} a rafraichir.`);
  startRefresh(5);
}

// 127.0.0.1 et pas 0.0.0.0 : l'app est personnelle, inutile de l'exposer au
// reseau local (wifi partage, etc.).
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Ciné IDF tourne déjà sur http://localhost:${PORT}. Rien à faire.`);
    process.exit(0);
  }
  throw err;
});

/** Adresses IPv4 de la machine sur le reseau local. */
function adressesLocales() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

server.listen(PORT, HOST, () => {
  console.log(`Ciné IDF -> http://localhost:${PORT}`);
  if (HOST !== '127.0.0.1') {
    for (const ip of adressesLocales()) console.log(`   sur le réseau local : http://${ip}:${PORT}`);
  }

  // L'app se tient a jour toute seule : au demarrage, puis tant qu'une fenetre
  // est ouverte, des qu'un jour depasse sa duree de fraicheur (freshness.js).
  autoRefresh('demarrage');
  autoWatchlist();

  setInterval(() => {
    // Ecriture periodique : fait remonter les connexions mortes (fenetre fermee
    // brutalement, veille) que la socket n'a pas encore signalees.
    for (const client of liveClients) {
      try {
        client.write(': keep-alive\n\n');
      } catch {
        liveClients.delete(client);
      }
    }

    // Ni pendant une recuperation (meme lancee en ligne de commande), ni tant
    // qu'une fenetre de l'app est ouverte.
    if (liveClients.size > 0) { autoRefresh('app ouverte'); autoWatchlist(); }
    if (refresh.running || externalRefreshRunning() || liveClients.size > 0) {
      lastRequestAt = Date.now();
      return;
    }
    if (Date.now() - lastRequestAt > IDLE_MIN * 60000) {
      console.log(`Inactif depuis ${IDLE_MIN} min : arret du serveur.`);
      process.exit(0);
    }
  }, 30000).unref();
});
