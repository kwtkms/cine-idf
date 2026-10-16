// Synchronisation automatique de la watchlist Letterboxd, a partir du seul pseudo.
//
//   node src/letterboxd-watchlist.js <pseudo>
//
// Depuis l'automne 2026, la page publique https://letterboxd.com/<pseudo>/watchlist/
// est rendue cote serveur : chaque film y figure avec son titre, son annee et son
// identifiant Letterboxd (data-item-name="May (2002)" data-item-slug="may"), 28 par
// page. Plus besoin d'export ni de marque-page : il suffit de relire ces pages.
// (Avant, la grille etait chargee en JavaScript derriere Cloudflare et ce n'etait
// possible que depuis le navigateur — d'ou l'ancien marque-page, garde en secours.)
//
// La watchlist doit etre publique, ce qui est le reglage par defaut de Letterboxd.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const WATCHLIST = path.join(DATA, 'watchlist.json');
const ETAT = path.join(DATA, 'watchlist-sync.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
const MAX_PAGES = 80; // 2 240 films : largement au-dela d'une watchlist normale

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const pseudoValide = (p) => typeof p === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(p.trim());

const lire = (f) => {
  try {
    const raw = fs.readFileSync(f, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return null;
  }
};

/** Etat de la synchro : pseudo, derniere tentative, resultat. */
export function etatSync() {
  const etat = lire(ETAT) || {};
  // Pseudo deja connu par l'ancien marque-page : on le reprend tel quel.
  if (!etat.pseudo) {
    const wl = lire(WATCHLIST);
    if (pseudoValide(wl?.pseudo)) etat.pseudo = wl.pseudo;
  }
  return etat;
}

function ecrireEtat(etat) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(ETAT, JSON.stringify(etat, null, 1));
}

export function definirPseudo(pseudo) {
  const etat = etatSync();
  ecrireEtat({ ...etat, pseudo: pseudo ? pseudo.trim() : null, at: null, ok: null, error: null, count: null });
}

const decoder = (s) => s
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&amp;/g, '&');

/** Films d'une page : { title, year, slug }. */
function extraire(html) {
  const films = [];
  for (const m of html.matchAll(/<div[^>]*data-component-class="LazyPoster"[^>]*>/g)) {
    const balise = m[0];
    const nom = (balise.match(/data-item-name="([^"]*)"/) || [])[1];
    const slug = (balise.match(/data-item-slug="([^"]*)"/) || [])[1];
    if (!nom || !slug) continue;
    const texte = decoder(nom);
    const a = texte.match(/^(.*)\s\((\d{4})\)$/);
    films.push({ title: (a ? a[1] : texte).trim(), year: a ? Number(a[2]) : null, slug });
  }
  return films;
}

async function page(pseudo, n) {
  const url = `https://letterboxd.com/${encodeURIComponent(pseudo)}/watchlist/${n > 1 ? `page/${n}/` : ''}`;
  for (let essai = 1; essai <= 3; essai++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en;q=0.9' },
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 404) return { status: 404, html: '' };
      if (res.status === 429 || res.status >= 500) { await sleep(3000 * essai); continue; }
      return { status: res.status, html: await res.text() };
    } catch {
      await sleep(1500 * essai);
    }
  }
  throw new Error('Letterboxd ne répond pas');
}

/**
 * Relit toute la watchlist publique et l'enregistre dans data/watchlist.json
 * (meme format que l'ancien marque-page : l'interface la reprend telle quelle).
 * N'ecrit rien si la lecture est incomplete : une coupure ne vide jamais la liste.
 */
export async function syncWatchlist(pseudoDemande) {
  const etat = etatSync();
  const pseudo = (pseudoDemande || etat.pseudo || '').trim();
  if (!pseudoValide(pseudo)) throw new Error('pseudo Letterboxd manquant ou invalide');

  const at = new Date().toISOString();
  try {
    const films = [];
    for (let n = 1; n <= MAX_PAGES; n++) {
      const { status, html } = await page(pseudo, n);
      if (n === 1 && status === 404) throw new Error(`aucun compte Letterboxd « ${pseudo} »`);
      if (status !== 200) throw new Error(`Letterboxd a répondu ${status}`);
      const lot = extraire(html);
      if (n === 1 && !lot.length && /is private|private watchlist/i.test(html)) {
        throw new Error('watchlist privée sur Letterboxd — rends-la publique, ou importe le fichier');
      }
      films.push(...lot);
      const suivante = html.includes(`/watchlist/page/${n + 1}/`);
      if (!lot.length || !suivante) break;
      await sleep(700);
    }

    // Doublons possibles si la liste change pendant la lecture
    const vus = new Set();
    const uniques = films.filter((f) => (vus.has(f.slug) ? false : vus.add(f.slug)));

    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(WATCHLIST, JSON.stringify({ recuLe: at, pseudo, source: 'auto', films: uniques }, null, 1));
    const fin = { pseudo, at, ok: true, error: null, count: uniques.length };
    ecrireEtat(fin);
    return fin;
  } catch (err) {
    // Un nouveau pseudo qui echoue (faute de frappe…) ne remplace pas celui qui
    // marchait : on ne note l'echec que pour le pseudo deja enregistre.
    if (!etat.pseudo || pseudo === etat.pseudo) ecrireEtat({ ...etat, pseudo, at, ok: false, error: err.message });
    throw err;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  syncWatchlist(process.argv[2])
    .then((r) => console.log(`watchlist de ${r.pseudo} : ${r.count} films`))
    .catch((e) => { console.error(e.message); process.exitCode = 1; });
}
