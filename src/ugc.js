// Marque les salles ou la carte UGC Illimite est acceptee.
//
//   node src/ugc.js
//
// La liste officielle est publiee par UGC sur une page unique, rendue cote
// serveur : https://www.ugc.fr/cinemas-acceptant-ui.html
// Elle couvre les cinemas UGC ET les cinemas partenaires (mk2, nombreuses
// salles independantes...). Le reseau bouge, d'ou ce script relancable.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data', 'theaters.json');
const SOURCE = 'https://www.ugc.fr/cinemas-acceptant-ui.html';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const IDF = /^(75|77|78|91|92|93|94|95)/;

const log = (m) => console.log(`[${new Date().toLocaleTimeString('fr-FR')}] ${m}`);

/* ------------------------------------------------------------- decodage */

const ENTITES = {
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ecirc: 'ê', icirc: 'î',
  ocirc: 'ô', ucirc: 'û', euml: 'ë', iuml: 'ï', uuml: 'ü', ugrave: 'ù',
  acirc: 'â', aelig: 'æ', oelig: 'œ', nbsp: ' ', amp: '&', rsquo: "'",
  lsquo: "'", quot: '"', apos: "'", laquo: '«', raquo: '»', hellip: '…',
};

function decode(s) {
  return s
    .replace(/&([A-Za-z]+);/g, (m, nom) => {
      const c = ENTITES[nom.toLowerCase()];
      if (c === undefined) return m;
      // &Eacute; doit rendre É, pas é
      return /^[A-Z]/.test(nom) && /[a-zà-ÿ]/.test(c) ? c.toUpperCase() : c;
    })
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
}

/** La page liste, pour chaque salle : nom, adresse, puis "CP VILLE". */
function parsePage(html) {
  const propre = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  const lignes = propre.replace(/<[^>]+>/g, '\n').split('\n')
    .map((x) => decode(x).replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const salles = [];
  const vues = new Set();
  for (let i = 2; i < lignes.length; i++) {
    const m = lignes[i].match(/^(\d{5})\s+(.+)$/);
    if (!m || !IDF.test(m[1])) continue;
    const salle = { nom: lignes[i - 2], adresse: lignes[i - 1], cp: m[1], ville: m[2] };
    const cle = `${salle.nom}|${salle.cp}`;
    if (vues.has(cle)) continue;
    vues.add(cle);
    salles.push(salle);
  }
  return salles;
}

/* ---------------------------------------------------------- rapprochement */

const norm = (s) => s.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['cinema', 'cine', 'les', 'le', 'la', 'des', 'du', 'de', 'cite', 'espace', 'salle', 'cote']);
const mots = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w)));
const TYPES_VOIE = new Set(['rue', 'avenue', 'av', 'boulevard', 'bd', 'place', 'pl', 'cours', 'quai', 'allee', 'route', 'esplanade', 'impasse', 'mail']);
const voie = (a) => new Set(norm(a).split(' ').filter((w) => w.length > 2 && !TYPES_VOIE.has(w) && isNaN(w)));
const numero = (a) => (norm(a).match(/^(\d+)/) || [])[1] ?? null;

/**
 * Affectation gloutonne : on note toutes les paires possibles, puis on prend
 * les meilleures en s'interdisant de réutiliser une salle. C'est ce qui permet
 * de distinguer deux homonymes comme les deux "Ariel" de Rueil-Malmaison.
 */
function rapprocher(salles, theaters) {
  const paires = [];
  for (const u of salles) {
    const nu = norm(u.nom), mu = mots(u.nom), vu = voie(u.adresse), numU = numero(u.adresse);
    for (const t of theaters) {
      const nt = norm(t.name), mt = mots(t.name);
      let s = 0;
      if (nt === nu) s = 100;
      else if (nt.includes(nu) || nu.includes(nt)) s = 80;
      else {
        const inter = [...mu].filter((w) => mt.has(w)).length;
        s = inter ? (65 * inter) / Math.max(mu.size, mt.size, 1) : 0;
      }
      if (!s) continue;

      if (t.postalCode === u.cp) s += 25;
      else if (t.dept === u.cp.slice(0, 2)) s += 10;

      const vt = voie(t.address);
      const communs = [...vu].filter((w) => vt.has(w)).length;
      if (communs) s += (30 * communs) / Math.max(vu.size, 1);
      if (numU && numero(t.address) === numU) s += 20;

      paires.push({ u, t, s });
    }
  }

  paires.sort((a, b) => b.s - a.s);
  const prisU = new Set(), prisT = new Set(), retenus = [];
  for (const p of paires) {
    const cleU = `${p.u.nom}|${p.u.cp}`;
    if (p.s < 35 || prisU.has(cleU) || prisT.has(p.t.id)) continue;
    prisU.add(cleU); prisT.add(p.t.id); retenus.push(p);
  }
  return { retenus, manquants: salles.filter((u) => !prisU.has(`${u.nom}|${u.cp}`)) };
}

/* ------------------------------------------------------------------ main */

export async function tagUgcIllimite() {
  const res = await fetch(SOURCE, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`page UGC : HTTP ${res.status}`);

  const salles = parsePage(await res.text());
  if (salles.length < 50) throw new Error(`liste UGC suspecte (${salles.length} salles) — la page a peut-etre change`);
  log(`${salles.length} salles UGC Illimite en Ile-de-France sur ugc.fr`);

  const db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const { retenus, manquants } = rapprocher(salles, db.theaters);

  const ids = new Set(retenus.map((p) => p.t.id));
  for (const t of db.theaters) {
    if (ids.has(t.id)) t.ugc = true;
    else delete t.ugc;
  }
  db.ugcCheckedAt = new Date().toISOString();
  db.ugcSource = SOURCE;
  fs.writeFileSync(FILE, JSON.stringify(db, null, 1));

  log(`${ids.size}/${salles.length} rapprochees dans la base`);
  for (const u of manquants) log(`  ! non trouvee chez AlloCine : ${u.nom} (${u.cp} ${u.ville})`);
  return { total: salles.length, tagged: ids.size, manquants };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  tagUgcIllimite().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
