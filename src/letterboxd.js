// Recupere les notes Letterboxd des films a l'affiche.
//
//   node src/letterboxd.js            -> complete les films manquants
//   node src/letterboxd.js --retry    -> retente aussi les films non trouves
//
// Letterboxd n'a pas d'API ouverte et sa recherche est rendue cote client. En
// revanche, la FICHE d'un film est rendue cote serveur et contient la note dans
// un bloc JSON-LD. On reconstruit donc l'adresse a partir du titre.
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
const MAX_ESSAIS = 4;      // adresses testees par film
const REESSAI_JOURS = 30;  // avant de retenter un film resté introuvable

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toLocaleTimeString('fr-FR')}] ${m}`);

const slugify = (s) => s
  .normalize('NFD').replace(/\p{Mn}/gu, '')
  .toLowerCase()
  .replace(/['’]/g, ' ')
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
    const s = slugify(b);
    if (!s) continue;
    if (movie.year) out.push(`${s}-${movie.year}`);
    out.push(s);
  }
  return out.slice(0, MAX_ESSAIS);
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
async function resoudre(movie) {
  for (const slug of candidats(movie)) {
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
    if (info.annee && movie.year && Math.abs(info.annee - movie.year) > 1) continue;
    if (info.note == null) continue;

    return { slug, note: info.note, votes: info.votes, annee: info.annee };
  }
  return null;
}

/* ------------------------------------------------------------------ main */

function chargerCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  } catch {
    return {};
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

  const aFaire = [...films.values()].filter((m) => {
    const c = cache[m.id];
    if (!c) return true;
    if (c.note != null) return false;                       // deja connu
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
    const r = await resoudre(m);
    cache[m.id] = r
      ? { ...r, titre: m.title, checkedAt: new Date().toISOString() }
      : { note: null, titre: m.title, checkedAt: new Date().toISOString() };
    if (r) trouves++;

    if ((i + 1) % 25 === 0) {
      fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1));
      log(`  ${i + 1}/${aFaire.length} — ${trouves} notes trouvees`);
    }
  }

  fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1));
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
