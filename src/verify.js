// Controle d'exhaustivite : re-telecharge chaque salle du perimetre en direct
// et compare seance par seance avec ce que l'app a stocke.
//
//   npm run verify              -> aujourd'hui et demain (~10 min)
//   npm run verify -- --days=5  -> toute la fenetre (~25 min)
//
// Ne modifie rien. A ne pas lancer pendant une mise a jour : les deux
// additionneraient leurs requetes et AlloCine finirait par bloquer.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request, warmUp, configureThrottle } from './allocine.js';
import { localDate } from './freshness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const hit = process.argv.find((a) => a.startsWith('--days='));
const DAYS = Math.max(1, Math.min(21, Number(hit ? hit.split('=')[1] : 2)));

const readJson = (f) => {
  const raw = fs.readFileSync(f, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
};
const nowHM = () => new Date().toTimeString().slice(0, 5);

if (fs.existsSync(path.join(DATA, '.refresh.lock'))) {
  const pid = Number(fs.readFileSync(path.join(DATA, '.refresh.lock'), 'utf8'));
  try {
    process.kill(pid, 0);
    console.log('Une mise a jour est en cours : relance la verification quand elle sera terminee.');
    process.exit(3);
  } catch { /* verrou orphelin */ }
}

try { configureThrottle(readJson(path.join(DATA, 'rate.json'))); } catch { /* debit par defaut */ }

let ugcOnly = true;
try { ugcOnly = readJson(path.join(DATA, 'scope.json')).ugcOnly !== false; } catch { /* defaut */ }
const theaters = readJson(path.join(DATA, 'theaters.json')).theaters.filter((t) => !ugcOnly || t.ugc);
const dates = Array.from({ length: DAYS }, (_, i) => localDate(i))
  .filter((d) => fs.existsSync(path.join(DATA, `day-${d}.json`)));
const today = localDate(0);

/** Tous les horaires d'une salle, en suivant les pages jusqu'a une page vide. */
async function live(id, date) {
  const base = `https://www.allocine.fr/_/showtimes/theater-${id}/d-${date}/`;
  const referer = `https://www.allocine.fr/seance/salle_gen_csalle=${id}.html`;
  const out = new Map();
  for (let p = 1; p <= 25; p++) {
    const page = await request(p === 1 ? base : `${base}?page=${p}`, { json: true, referer });
    if (!page?.results?.length) break;
    for (const e of page.results) {
      const m = e.movie?.internalId;
      if (!m) continue;
      for (const list of Object.values(e.showtimes || {})) {
        if (!Array.isArray(list)) continue;
        for (const s of list) if (s?.startsAt) out.set(`${m}|${s.startsAt.slice(11, 16)}`, e.movie.title);
      }
    }
  }
  return out;
}

console.log(`Verification de ${theaters.length} salles sur ${dates.length} jour(s) : ${dates.join(', ')}`);
await warmUp();

const missing = [];
const extra = [];
const totals = {};
const jobs = dates.flatMap((d) => theaters.map((t) => [d, t]));
let next = 0;
let done = 0;
let failed = 0;

async function worker() {
  while (next < jobs.length) {
    const [date, t] = jobs[next++];
    const tot = (totals[date] ??= { direct: 0, app: 0 });
    let got;
    const at = nowHM();
    try {
      got = await live(t.id, date);
    } catch (err) {
      failed++;
      console.log(`  ! ${date} ${t.name} : ${err.message}`);
      continue;
    }
    // Relu a chaque fois : une mise a jour a pu passer entre-temps.
    const day = readJson(path.join(DATA, `day-${date}.json`));
    const mine = new Map(day.shows.filter((s) => s.t === t.id).map((s) => [`${s.m}|${s.s}`, day.movies[s.m]?.title || s.m]));
    tot.direct += got.size;
    tot.app += mine.size;
    for (const [k, title] of got) if (!mine.has(k)) missing.push(`${date} ${t.name} — ${title} a ${k.split('|')[1]}`);
    for (const [k, title] of mine) {
      if (got.has(k)) continue;
      if (date === today && k.split('|')[1] < at) continue; // seance deja commencee
      extra.push(`${date} ${t.name} — ${title} a ${k.split('|')[1]}`);
    }
    if (++done % 50 === 0) console.log(`  ${done}/${jobs.length}`);
  }
}
await Promise.all([worker(), worker(), worker()]);

console.log('');
for (const [d, t] of Object.entries(totals)) console.log(`${d} : ${t.direct} seances chez AlloCine, ${t.app} dans l'app`);
console.log(`\nManquantes dans l'app : ${missing.length}`);
for (const m of missing.slice(0, 40)) console.log(`  - ${m}`);
console.log(`Affichees mais plus chez AlloCine : ${extra.length}`);
for (const m of extra.slice(0, 40)) console.log(`  + ${m}`);
if (failed) console.log(`Salles non verifiees (erreur reseau) : ${failed}`);
console.log(missing.length || extra.length
  ? "\nEcarts trouves : si ce sont des programmes publies depuis la derniere mise a jour, cliquer « Mettre a jour » les recupere."
  : '\nAucun ecart : l\'app contient exactement ce qu\'AlloCine publie.');
