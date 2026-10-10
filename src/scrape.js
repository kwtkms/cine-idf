// Recupere cinemas + seances d'Ile-de-France et ecrit les fichiers de data/.
//
//   node src/scrape.js                 -> 5 jours, reprend ce qui manque
//   node src/scrape.js --days=7
//   node src/scrape.js --force         -> ignore le cache, tout refaire
//   node src/scrape.js --theaters-only -> met a jour la seule liste des cinemas
//
// La recuperation est incrementale : le fichier du jour est reecrit toutes les
// 25 salles. Si AlloCine coupe (Cloudflare), rien n'est perdu — relancer la
// commande reprend exactement la ou ca s'est arrete.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZONES, fetchTheatersForZone, fetchShowtimes, warmUp, throttle, configureThrottle, BlockedError } from './allocine.js';
import { geocodeTheaters } from './geocode.js';
import { tagUgcIllimite } from './ugc.js';
import { majNotesLetterboxd } from './letterboxd.js';
import { SPARSE_RATIO, freshHours, localDate, referenceVolume } from './freshness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const CONCURRENCY = 3;
const FLUSH_EVERY = 25;

// Fraicheur par palier (aujourd'hui, jours creux, demain, au-dela) : voir
// freshness.js, partage avec le serveur.

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
const DAYS = Math.max(1, Math.min(21, Number(arg('days', 5))));
const FORCE = argv.includes('--force');
const THEATERS_ONLY = argv.includes('--theaters-only');

/**
 * Perimetre : par defaut on ne recupere que les salles ou la carte UGC Illimite
 * est acceptee (103 sur 362), ce qui divise le temps par 3,5. `--all` reprend
 * tout, et l'interface peut changer ce reglage via data/scope.json.
 */
function ugcOnly() {
  if (argv.includes('--all')) return false;
  if (argv.includes('--ugc-only')) return true;
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, 'scope.json'), 'utf8')).ugcOnly !== false;
  } catch {
    return true;
  }
}

const log = (msg) => console.log(`[${new Date().toLocaleTimeString('fr-FR')}] ${msg}`);

/**
 * Lignes lisibles par le serveur, qui les transforme en barre de progression et
 * en messages d'erreur dans l'interface. Prefixe `##` pour ne pas les melanger
 * au journal humain.
 *   P = progression, D = termine, E = erreur
 */
const emit = (tag, payload) => {
  console.log(`##${tag} ${JSON.stringify(payload)}`);
  // Aussi sur disque : une recuperation lancee en ligne de commande n'a pas le
  // serveur pour parent, et l'interface doit quand meme pouvoir suivre.
  if (tag === 'P') {
    try {
      fs.writeFileSync(path.join(DATA, 'progress.json'), JSON.stringify({ ...payload, at: Date.now() }));
    } catch { /* pas bloquant */ }
  }
};
let lastBudgetLog = 0;
throttle.onEvent = (type, d) => {
  if (type === 'throttled') {
    log(`  ~ AlloCine bloque : pause ${Math.round(d.pause / 60000)} min (debit reduit a ${d.budget} requetes/10 min)`);
  } else if (type === 'budget' && Date.now() - lastBudgetLog > 60000) {
    lastBudgetLog = Date.now();
    log(`  ~ quota atteint, attente ${Math.round(d.wait / 1000)}s avant de reprendre`);
  }
};

/**
 * Salle sans programme un jour donne : AlloCine renvoie `nextDate`, la prochaine
 * date ou elle a quelque chose. Ce n'est PAS une fermeture : pour un jour a
 * venir, ca veut surtout dire que le programme n'est pas encore publie. On ne
 * s'en sert donc que pour sauter les jours SUIVANTS (jamais les precedents) au
 * cours d'une meme mise a jour, et on reinterroge a la suivante.
 * Ancienne version : l'info etait crue deux jours et appliquee a toutes les
 * dates avant `until`, aujourd'hui compris — 34 salles ouvertes etaient sautees.
 */
const CLOSED_FILE = () => path.join(DATA, 'closed-until.json');
const CLOSED_TRUST_MS = 3600000;

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

function loadClosed() {
  try {
    const raw = JSON.parse(stripBom(fs.readFileSync(CLOSED_FILE(), 'utf8')));
    // Anciens formats (chaine seule, ou sans `from`) : non fiables, on les
    // abandonne pour que le fichier ne garde que des constats exploitables.
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => v && typeof v === 'object' && v.from));
  } catch {
    return {};
  }
}

/**
 * JSON.parse echoue sur un BOM UTF-8. Sans ca, un fichier reecrit par un autre
 * outil (PowerShell, un editeur) est juge illisible et la journee complete est
 * silencieusement reconstruite de zero.
 */
const readJson = async (file) => JSON.parse(stripBom(await fsp.readFile(file, 'utf8')));

function isKnownClosed(closed, id, date) {
  const e = closed[id];
  // Ancien format (sans `from`, ou `seenAt` sans heure) : pas fiable.
  if (!e?.until || !e.from || !e.seenAt || e.seenAt.length < 11) return false;
  if (Date.now() - Date.parse(e.seenAt) > CLOSED_TRUST_MS) return false;
  return date >= e.from && date < e.until;
}

/** Pool a taille fixe. S'arrete net si un worker leve BlockedError. */
async function pool(items, size, worker) {
  let cursor = 0;
  let fatal = null;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length && !fatal) {
      const item = items[cursor++];
      try {
        await worker(item);
      } catch (err) {
        if (err instanceof BlockedError) fatal = err;
        else log(`  ! ${err.message}`);
      }
    }
  });
  await Promise.all(runners);
  if (fatal) throw fatal;
}

/* ------------------------------------------------------------- cinemas */

async function collectTheaters() {
  const byId = new Map();
  for (const zone of ZONES) {
    const list = await fetchTheatersForZone(zone);
    for (const t of list) if (!byId.has(t.id)) byId.set(t.id, { ...t, zone: zone.name });
    log(`${zone.name.padEnd(20)} ${String(list.length).padStart(3)} cinemas`);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/* -------------------------------------------------------- normalisation */

const runtimeToMinutes = (s) => {
  if (!s) return null;
  const h = /(\d+)\s*h/.exec(s);
  const m = /(\d+)\s*min/.exec(s);
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0) || null;
};

// AlloCine n'emet pas toujours le tag de sous-titrage : un film etranger en
// "version originale" est de fait sous-titre en France. On tranche donc sur la
// langue du film plutot que sur le tag, et on s'en tient a VF / VOST.
function versionOf(showtime, languages = []) {
  const french = languages.includes('FRENCH');
  const subtitled = (showtime.tags || []).some((t) => t.startsWith('Localization.Subtitle.'));
  switch (showtime.diffusionVersion) {
    case 'ORIGINAL': return french && !subtitled ? 'VF' : 'VOST';
    case 'DUBBED':
    case 'LOCAL': return 'VF';
    default: return subtitled ? 'VOST' : 'VF';
  }
}

function bookingUrl(showtime) {
  const tickets = showtime.data?.ticketing || [];
  const direct = tickets.find((t) => t.provider !== 'relay')?.urls?.[0];
  return direct || tickets[0]?.urls?.[0] || null;
}

const personName = (p) => [p?.firstName, p?.lastName].filter(Boolean).join(' ').trim();

function directorsOf(mv) {
  return (mv.credits || [])
    .filter((c) => c.position?.name === 'DIRECTOR')
    .map((c) => personName(c.person))
    .filter(Boolean);
}

function castOf(mv, max = 4) {
  return (mv.cast?.edges || [])
    .map((e) => personName(e.node?.actor))
    .filter(Boolean)
    .slice(0, max);
}

function movieRecord(mv) {
  return {
    id: mv.internalId,
    directors: directorsOf(mv),
    cast: castOf(mv),
    title: (mv.title || mv.originalTitle || 'Sans titre').trim(),
    originalTitle: mv.originalTitle?.trim() || null,
    runtime: runtimeToMinutes(mv.runtime),
    genres: (mv.genres || []).map((g) => g.translate).filter(Boolean),
    year: mv.data?.productionYear ?? null,
    poster: mv.poster?.url ?? null,
    synopsis: (mv.synopsis || '').replace(/\s+/g, ' ').trim().slice(0, 600) || null,
    userRating: mv.stats?.userRating?.score ?? null,
    pressRating: mv.stats?.pressReview?.score ?? null,
    releaseDate: mv.releases?.[0]?.releaseDate?.date ?? null,
    url: `https://www.allocine.fr/film/fichefilm_gen_cfilm=${mv.internalId}.html`,
  };
}

/** Nombre brut d'horaires dans une reponse AlloCine (avant dedoublonnage). */
const countShows = (results) =>
  results.reduce((n, e) => n + Object.values(e.showtimes || {}).reduce((k, l) => k + (Array.isArray(l) ? l.length : 0), 0), 0);

/**
 * Remplace les seances d'une salle. `byTheater` indexe les seances par salle :
 * c'est ce qui permet de rafraichir une journee sans jamais la vider, en
 * substituant salle par salle au lieu de repartir d'une page blanche.
 */
function mergeTheater(day, byTheater, theaterId, results) {
  const shows = [];
  const seen = new Set();
  for (const entry of results) {
    const mv = entry.movie;
    if (!mv?.internalId) continue;
    if (!day.movies[mv.internalId]) day.movies[mv.internalId] = movieRecord(mv);

    for (const list of Object.values(entry.showtimes || {})) {
      if (!Array.isArray(list)) continue;
      for (const s of list) {
        if (!s?.startsAt) continue;
        const show = {
          t: theaterId,
          m: mv.internalId,
          s: s.startsAt.slice(11, 16), // HH:MM
          v: versionOf(s, mv.languages || []),
          p: s.isPreview ? 1 : 0,
          u: bookingUrl(s),
        };
        // Un meme horaire peut apparaitre dans plusieurs listes de versions.
        const key = `${show.m}|${show.s}|${show.v}`;
        if (seen.has(key)) continue;
        seen.add(key);
        shows.push(show);
      }
    }
  }
  byTheater.set(theaterId, shows); // remplace, ne s'ajoute pas
}

function finalize(day, byTheater, theaterCount) {
  day.shows = [...byTheater.values()].flat()
    .sort((a, b) => a.s.localeCompare(b.s) || a.t.localeCompare(b.t));

  // Les films sans aucune seance restante n'ont plus lieu d'etre transportes.
  const used = new Set(day.shows.map((s) => String(s.m)));
  for (const id of Object.keys(day.movies)) if (!used.has(id)) delete day.movies[id];

  day.counts = {
    shows: day.shows.length,
    movies: Object.keys(day.movies).length,
    theaters: new Set(day.shows.map((s) => s.t)).size,
    theatersScanned: day.scanned.length,
    theatersTotal: theaterCount,
  };
  return day;
}

/* ------------------------------------------------------------ une journee */

function emptyDay(date) {
  return { date, fetchedAt: null, complete: false, scanned: [], movies: {}, shows: [], counts: {} };
}

async function scrapeDay(theaters, date, closed, offset, totalDays, reference = 0) {
  const file = path.join(DATA, `day-${date}.json`);
  let day = emptyDay(date);
  let inPlace = false;
  const progress = (done, shows) =>
    emit('P', { date, day: offset + 1, days: totalDays, done, total: theaters.length, shows });

  if (!FORCE && fs.existsSync(file)) {
    try {
      const prev = await readJson(file);
      const ageH = prev.fetchedAt ? (Date.now() - Date.parse(prev.fetchedAt)) / 3600000 : Infinity;
      const sparse = (prev.counts?.shows ?? 0) < SPARSE_RATIO * reference;
      if (prev.complete && ageH < freshHours(offset, sparse)) {
        log(`${date} : deja a jour (${prev.counts?.shows ?? 0} seances, il y a ${ageH.toFixed(1)} h)`);
        progress(theaters.length, prev.counts?.shows ?? 0);
        return prev.counts;
      }
      if (prev.complete) {
        // Rafraichissement SUR PLACE : on reprend l'instantane precedent et on
        // remplace salle par salle. L'app affiche une journee complete du debut
        // a la fin, au lieu de se vider puis de se remplir pendant 5 minutes.
        day = { ...emptyDay(date), ...prev, scanned: [] };
        inPlace = true;
        log(`${date} : rafraichissement sur place (${prev.counts?.shows ?? 0} seances restent affichees pendant l'operation)`);
      } else if (prev.scanned?.length) {
        day = { ...emptyDay(date), ...prev, complete: false };
        log(`${date} : reprise (${prev.scanned.length}/${theaters.length} salles deja faites)`);
      }
    } catch { /* fichier illisible : on repart de zero */ }
  }

  // Index salle -> seances, reconstruit depuis l'instantane precedent. Les
  // salles hors perimetre sont ecartees : sans ca, changer de perimetre
  // laisserait trainer des seances qu'on ne rafraichit plus.
  const enScope = new Set(theaters.map((t) => t.id));
  const byTheater = new Map();
  let horsScope = 0;
  for (const s of day.shows) {
    if (!enScope.has(s.t)) { horsScope++; continue; }
    if (!byTheater.has(s.t)) byTheater.set(s.t, []);
    byTheater.get(s.t).push(s);
  }
  if (horsScope) log(`  ${date} : ${horsScope} seances hors perimetre retirees`);

  const scanned = new Set(day.scanned);
  let skipped = 0;
  const todo = theaters.filter((t) => {
    if (scanned.has(t.id)) return false;
    if (isKnownClosed(closed, t.id, date)) {
      scanned.add(t.id); // rien ce jour-la, AlloCine l'a dit il y a moins d'une heure
      skipped++;
      return false;
    }
    return true;
  });
  if (skipped) log(`  ${date} : ${skipped} salles sans programme ignorees (vu a l'instant)`);

  let sinceFlush = 0;
  let done = scanned.size;

  const flush = async () => {
    day.scanned = [...scanned];
    day.fetchedAt = new Date().toISOString();
    // Sur place, la journee reste un instantane complet pendant toute l'operation.
    day.complete = inPlace || scanned.size >= theaters.length;
    finalize(day, byTheater, theaters.length);
    await fsp.writeFile(file, JSON.stringify(day));
    await fsp.writeFile(CLOSED_FILE(), JSON.stringify(closed, null, 1));
    sinceFlush = 0;
  };

  try {
    await pool(todo, CONCURRENCY, async (t) => {
      let { results, nextDate } = await fetchShowtimes(t.id, date);
      // AlloCine renvoie parfois une reponse tronquee (vu le 14/09 : 60 seances
      // sur 150 aux Halles, totalPages a 1, complete vingt minutes plus tard).
      // Si le volume s'effondre par rapport a l'instantane precedent, on relit
      // une fois et on garde la plus fournie ; deux lectures faibles de suite
      // valent un vrai changement de programme.
      const avant = byTheater.get(t.id)?.length ?? 0;
      if (avant >= 10 && countShows(results) < avant / 2) {
        const again = await fetchShowtimes(t.id, date);
        if (countShows(again.results) > countShows(results)) ({ results, nextDate } = again);
      }
      mergeTheater(day, byTheater, t.id, results);
      if (nextDate && nextDate > date) closed[t.id] = { from: date, until: nextDate, seenAt: new Date().toISOString() };
      else if (results.length) delete closed[t.id];
      scanned.add(t.id);
      done++;
      if (++sinceFlush >= FLUSH_EVERY) {
        await flush();
        log(`  ${date} : ${done}/${theaters.length} salles · ${day.shows.length} seances`);
        progress(done, day.shows.length);
      }
    });
  } catch (err) {
    await flush();
    throw err;
  }

  await flush(); // met complete a jour et ecrit l'instantane final
  log(`${date} : ${day.counts.shows} seances · ${day.counts.movies} films · ${day.counts.theaters} cinemas ouverts`);
  progress(theaters.length, day.counts.shows);
  return day.counts;
}

/* ------------------------------------------------------------------ main */

/**
 * Ordonne les salles des plus fournies aux plus rares, d'apres ce qu'on a deja
 * vu. Le fichier du jour etant reecrit toutes les 25 salles, l'app affiche
 * l'essentiel de la programmation apres quelques minutes au lieu d'attendre
 * la fin. Les salles inconnues passent avant celles vues vides.
 */
function byUsefulness(theaters) {
  // Tes cinemas favoris d'abord : ce sont ceux que tu regardes, autant qu'ils
  // soient a jour au bout de quelques secondes plutot que d'un quart d'heure.
  let favs = new Set();
  try {
    favs = new Set(JSON.parse(fs.readFileSync(path.join(DATA, 'favorites.json'), 'utf8')));
  } catch { /* aucun favori enregistre */ }
  if (favs.size) log(`${favs.size} cinemas favoris passeront en premier`);

  const score = new Map();
  try {
    for (const f of fs.readdirSync(DATA)) {
      if (!/^day-\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;
      const day = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
      for (const s of day.shows || []) score.set(s.t, (score.get(s.t) || 0) + 1);
      for (const id of day.scanned || []) if (!score.has(id)) score.set(id, 0);
    }
  } catch { /* pas d'historique : on garde l'ordre alphabetique */ }
  if (!score.size && !favs.size) return theaters;

  const rank = (t) => (score.has(t.id) ? score.get(t.id) : 0.5); // inconnu : entre-deux
  return [...theaters].sort((a, b) => {
    const fa = favs.has(a.id) ? 0 : 1, fb = favs.has(b.id) ? 0 : 1;
    return fa - fb || rank(b) - rank(a) || a.name.localeCompare(b.name, 'fr');
  });
}

/** Un seul scrape a la fois : le serveur peut en lancer un pendant qu'un autre tourne. */
function acquireLock() {
  const lock = path.join(DATA, '.refresh.lock');
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    const alive = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
    if (alive) {
      log(`Une mise a jour est deja en cours (pid ${pid}). Rien a faire.`);
      process.exit(3);
    }
  }
  fs.writeFileSync(lock, String(process.pid));
  const release = () => { try { fs.unlinkSync(lock); } catch { /* deja parti */ } };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(130); });
}

async function main() {
  await fsp.mkdir(DATA, { recursive: true });
  acquireLock();
  const theatersFile = path.join(DATA, 'theaters.json');

  // Debit mesure par `node src/calibrate.js`, s'il a ete lance.
  try {
    const rate = await readJson(path.join(DATA, 'rate.json'));
    configureThrottle(rate);
    log(`debit calibre : ${rate.safeRatePerSecond} req/s (${rate.intervalMs} ms, ${rate.budgetPer10min}/10 min)`);
  } catch {
    log(`debit par defaut : ${Math.round(1000 / throttle.interval * 10) / 10} req/s — lance \`node src/calibrate.js\` pour l'optimiser`);
  }

  await warmUp();

  let theaters;
  const theatersAgeH = fs.existsSync(theatersFile)
    ? (Date.now() - fs.statSync(theatersFile).mtimeMs) / 3600000
    : Infinity;

  if (!FORCE && theatersAgeH < 24 * 7 && !THEATERS_ONLY) {
    theaters = (await readJson(theatersFile)).theaters;
    log(`${theaters.length} cinemas (liste en cache, ${theatersAgeH.toFixed(0)} h)`);
  } else {
    log("Recuperation de la liste des cinemas d'Ile-de-France...");
    theaters = await collectTheaters();

    // La liste est reconstruite a neuf : sans ca, les coordonnees deja
    // calculees seraient perdues a chaque rafraichissement hebdomadaire.
    try {
      const prev = (await readJson(theatersFile)).theaters;
      const coords = new Map(prev.filter((t) => Number.isFinite(t.lat)).map((t) => [t.id, t]));
      for (const t of theaters) {
        const old = coords.get(t.id);
        if (old && old.address === t.address) Object.assign(t, { lat: old.lat, lon: old.lon, geo: old.geo });
      }
    } catch { /* pas de liste precedente */ }

    await fsp.writeFile(theatersFile, JSON.stringify({ generatedAt: new Date().toISOString(), theaters }, null, 1));
    log(`${theaters.length} cinemas au total.`);

    try {
      await geocodeTheaters();
      theaters = (await readJson(theatersFile)).theaters;
    } catch (err) {
      log(`  ! geolocalisation indisponible (${err.message}) — le tri par distance sera inactif`);
    }

    // Le reseau de partenaires UGC Illimite evolue : on le resuit a chaque
    // rafraichissement de la liste des salles.
    try {
      await tagUgcIllimite();
      theaters = (await readJson(theatersFile)).theaters;
    } catch (err) {
      log(`  ! liste UGC Illimite non mise a jour (${err.message})`);
    }
  }
  if (THEATERS_ONLY) return;

  if (ugcOnly()) {
    const avant = theaters.length;
    theaters = theaters.filter((t) => t.ugc);
    if (!theaters.length) {
      log('! aucune salle marquee UGC Illimite — lance `node src/ugc.js` puis reessaie');
      process.exit(1);
    }
    log(`perimetre : carte UGC Illimite uniquement (${theaters.length}/${avant} salles)`);
  }

  const dates = Array.from({ length: DAYS }, (_, i) => localDate(i));
  const closed = FORCE ? {} : loadClosed();
  const ordered = byUsefulness(theaters);
  let interrupted = null;

  // Volume d'une journee normalement publiee, pour reperer les jours creux.
  const reference = referenceVolume(DATA, dates);

  for (const [offset, date] of dates.entries()) {
    try {
      await scrapeDay(ordered, date, closed, offset, dates.length, reference);
    } catch (err) {
      if (!(err instanceof BlockedError)) throw err;
      interrupted = err;
      log(`! ${err.message}`);
      emit('E', { kind: 'blocked', message: "AlloCiné a coupé les requêtes. Les journées déjà récupérées sont conservées." });
      break;
    }
  }

  // Menage des journees passees.
  for (const f of await fsp.readdir(DATA)) {
    const m = /^day-(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
    if (m && !dates.includes(m[1])) await fsp.rm(path.join(DATA, f));
  }

  // L'index est reconstruit depuis les fichiers presents : une journee seulement
  // partielle reste consultable dans l'interface.
  const days = [];
  for (const date of dates) {
    const file = path.join(DATA, `day-${date}.json`);
    if (!fs.existsSync(file)) continue;
    const d = await readJson(file);
    days.push({ date, complete: Boolean(d.complete), ...d.counts });
  }

  await fsp.writeFile(
    path.join(DATA, 'index.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), theaterCount: theaters.length, partial: Boolean(interrupted), days }, null, 1),
  );

  // Si AlloCine nous a fait ralentir, on retient le debit reellement tenable :
  // la prochaine recuperation demarrera directement au bon rythme au lieu de se
  // refaire bloquer. `npm run calibrate` remet le compteur a zero.
  try {
    const rateFile = path.join(DATA, 'rate.json');
    const rate = await readJson(rateFile);
    if (throttle.budget < rate.budgetPer10min) {
      const adjusted = {
        ...rate,
        adjustedAt: new Date().toISOString(),
        safeRatePerSecond: +(throttle.budget / 600).toFixed(2),
        intervalMs: throttle.interval,
        budgetPer10min: throttle.budget,
      };
      await fsp.writeFile(rateFile, JSON.stringify(adjusted, null, 1));
      log(`debit revu a la baisse et memorise : ${adjusted.safeRatePerSecond} req/s`);
    }
  } catch { /* pas de calibration enregistree */ }

  // Notes Letterboxd des nouveaux films. Mis en cache une fois pour toutes,
  // donc seule la nouveaute coute quelque chose. Jamais bloquant.
  try {
    await majNotesLetterboxd({ limite: 120 });
  } catch (err) {
    log(`  ! notes Letterboxd non mises a jour (${err.message})`);
  }

  emit('D', {
    days: days.length,
    complete: days.filter((d) => d.complete).length,
    shows: days.reduce((n, d) => n + (d.shows || 0), 0),
    theaters: theaters.length,
    partial: Boolean(interrupted),
  });

  if (interrupted) {
    log('Donnees partielles enregistrees. Relance `npm run refresh` plus tard pour completer.');
    process.exitCode = 2;
  } else {
    log('Termine.');
  }
}

main().catch((err) => {
  console.error(err);
  emit('E', { kind: 'crash', message: err.message || String(err) });
  process.exit(1);
});
