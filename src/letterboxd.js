// Recupere les notes Letterboxd des films a l'affiche.
//
//   node src/letterboxd.js            -> complete les films manquants
//   node src/letterboxd.js --retry    -> retente aussi les films non trouves
//
// Letterboxd n'a pas d'API ouverte et sa recherche est rendue cote client. En
// revanche, la FICHE d'un film est rendue cote serveur et contient la note dans
// un bloc JSON-LD. Pour trouver l'adresse de la fiche :
//   1. Wikidata, qui relie l'identifiant AlloCine (P1265) a celui de Letterboxd
//      (P6127) — indispensable pour les classiques, dont le titre francais n'a
//      rien a voir avec l'adresse (« A bout de souffle » -> breathless) ;
//   2. a defaut, l'adresse reconstruite a partir du titre.
//
// Les notes bougent peu : tout est mis en cache dans data/letterboxd.json et un
// film deja resolu n'est jamais redemande.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const CACHE = path.join(DATA, 'letterboxd.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ESPACEMENT = 1200;   // ms entre deux requetes
const MAX_ESSAIS = 6;      // adresses testees par film (hors Wikidata)
const REESSAI_JOURS = 30;  // avant de retenter un film resté introuvable

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toLocaleTimeString('fr-FR')}] ${m}`);

// Letterboxd supprime les apostrophes (« cuckoo's nest » -> cuckoos-nest).
// Avant, elles devenaient un tiret et l'adresse tombait a cote.
const slugify = (s, apostrophe = '') => s
  .normalize('NFD').replace(/\p{Mn}/gu, '')
  .toLowerCase()
  .replace(/['’]/g, apostrophe)
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

/**
 * Adresses candidates, de la plus sûre à la moins sûre. Le suffixe d'année est
 * essayé en premier : Letterboxd s'en sert pour départager les homonymes, et
 * sans lui on tombe sur "Michael" (2011) au lieu de celui de 2026.
 */
function candidats(movie) {
  const bases = [...new Set([movie.originalTitle, movie.title].filter(Boolean))];
  const out = [];
  for (const b of bases) {
    // Sans apostrophe d'abord (la regle de Letterboxd), puis l'ancienne variante.
    for (const s of new Set([slugify(b), slugify(b, ' ')])) {
      if (!s) continue;
      if (movie.year) out.push(`${s}-${movie.year}`);
      out.push(s);
    }
  }
  return [...new Set(out)].slice(0, MAX_ESSAIS);
}

/**
 * Adresses Letterboxd connues de Wikidata pour ces films AlloCine, en une ou
 * deux requetes. Jamais bloquant : en cas d'echec, on retombe sur les titres.
 */
async function slugsWikidata(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const lot = ids.slice(i, i + 200).map((id) => JSON.stringify(String(id))).join(' ');
    const query = `SELECT ?allo ?lb WHERE { VALUES ?allo { ${lot} } ?f wdt:P1265 ?allo . ?f wdt:P6127 ?lb . }`;
    try {
      const res = await fetch('https://query.wikidata.org/sparql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/sparql-results+json',
          'User-Agent': 'cine-idf/1.0 (application personnelle)',
        },
        body: 'query=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const b of (await res.json()).results.bindings) out.set(b.allo.value, b.lb.value);
    } catch (err) {
      log(`  ! Wikidata indisponible (${err.message}) — recherche par titre uniquement`);
      break;
    }
  }
  return out;
}

function extraire(html) {
  const bloc = (html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1];
  if (!bloc) return null;
  try {
    const json = JSON.parse(bloc.replace(/^\s*\/\*[\s\S]*?\*\//, '').replace(/\/\*[\s\S]*?\*\/\s*$/, '').trim());
    const annee = Number((html.match(/\/films\/year\/(\d{4})/) || [])[1]) || null;
    const note = json.aggregateRating;
    return {
      annee,
      note: note ? Number(note.ratingValue) : null,
      votes: note ? Number(note.ratingCount) : null,
      titre: json.name || null,
    };
  } catch {
    return null;
  }
}

/** Cherche la fiche d'un film et renvoie sa note, ou null si rien de fiable. */
async function resoudre(movie, slugWd) {
  for (const slug of [...new Set([slugWd, ...candidats(movie)].filter(Boolean))]) {
    let res;
    try {
      res = await fetch(`https://letterboxd.com/film/${slug}/`, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en;q=0.9' },
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      await sleep(ESPACEMENT);
      continue;
    }

    if (res.status === 429) {
      log('  ~ Letterboxd limite le debit, pause 60 s');
      await sleep(60000);
      continue;
    }
    if (res.status !== 200) { await sleep(ESPACEMENT); continue; }

    const info = extraire(await res.text());
    await sleep(ESPACEMENT);
    if (!info) continue;

    // Mauvais film : meme titre, autre annee. On passe au candidat suivant.
    // L'adresse donnee par Wikidata est sure : pas de controle d'annee (AlloCine
    // date parfois la ressortie plutot que le film).
    if (slug !== slugWd && info.annee && movie.year && Math.abs(info.annee - movie.year) > 1) continue;
    if (info.note == null) continue;

    return { slug, note: info.note, votes: info.votes, annee: info.annee };
  }
  return null;
}

/* ------------------------------------------------------------------ main */

/**
 * Cache absent : on part de zero. Cache present mais illisible : on s'arrete,
 * sinon la sauvegarde suivante ecraserait des centaines de notes deja trouvees.
 */
function chargerCache() {
  if (!fs.existsSync(CACHE)) return {};
  const raw = fs.readFileSync(CACHE, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}

/** Ecriture dans un fichier temporaire puis renommage : jamais de cache a moitie ecrit. */
function sauverCache(cache) {
  const tmp = `${CACHE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 1));
  try {
    fs.renameSync(tmp, CACHE);
  } catch {
    // Fichier verrouille par un lecteur sous Windows : ecriture directe.
    fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1));
    fs.rmSync(tmp, { force: true });
  }
}

/** Films distincts presents dans les journees recuperees. */
function filmsAffiches() {
  const films = new Map();
  for (const f of fs.readdirSync(DATA).filter((x) => /^day-\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
    try {
      const jour = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
      for (const m of Object.values(jour.movies || {})) films.set(String(m.id), m);
    } catch { /* fichier illisible */ }
  }
  return films;
}

export async function majNotesLetterboxd({ retry = false, limite = Infinity } = {}) {
  const cache = chargerCache();
  const films = filmsAffiches();
  const maintenant = Date.now();

  // Une seule requete Wikidata pour tous les films encore sans note.
  const sansNote = [...films.keys()].filter((id) => cache[id]?.note == null);
  const wd = sansNote.length ? await slugsWikidata(sansNote) : new Map();

  const aFaire = [...films.values()].filter((m) => {
    const c = cache[m.id];
    if (!c) return true;
    if (c.note != null) return false;                       // deja connu
    // Piste Wikidata pas encore essayee : inutile d'attendre 30 jours.
    if (wd.has(String(m.id)) && c.wd !== wd.get(String(m.id))) return true;
    if (!retry && (maintenant - Date.parse(c.checkedAt)) / 86400000 < REESSAI_JOURS) return false;
    return true;
  }).slice(0, limite);

  if (!aFaire.length) {
    const connus = [...films.keys()].filter((id) => cache[id]?.note != null).length;
    log(`notes Letterboxd : ${connus}/${films.size} films, rien a completer`);
    return { total: films.size, connus, nouveaux: 0 };
  }

  log(`notes Letterboxd : ${aFaire.length} films a chercher (${films.size} a l'affiche)`);
  let trouves = 0;
  for (const [i, m] of aFaire.entries()) {
    const slugWd = wd.get(String(m.id)) || null;
    const r = await resoudre(m, slugWd);
    cache[m.id] = r
      ? { ...r, titre: m.title, checkedAt: new Date().toISOString() }
      : { note: null, titre: m.title, wd: slugWd, checkedAt: new Date().toISOString() };
    if (r) trouves++;

    if ((i + 1) % 25 === 0) {
      sauverCache(cache);
      log(`  ${i + 1}/${aFaire.length} — ${trouves} notes trouvees`);
    }
  }

  sauverCache(cache);
  const connus = [...films.keys()].filter((id) => cache[id]?.note != null).length;
  log(`notes Letterboxd : ${trouves} nouvelles, ${connus}/${films.size} films couverts`);
  return { total: films.size, connus, nouveaux: trouves };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  majNotesLetterboxd({ retry: process.argv.includes('--retry') }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
