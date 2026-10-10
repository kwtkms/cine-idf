// Mesure le debit reellement tolere par AlloCine, au lieu de le deviner.
//
//   node src/calibrate.js
//
// Monte par paliers et s'arrete au premier 429. Ecrit data/rate.json, que le
// scraper relit ensuite. A relancer si AlloCine change ses regles.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Paliers en requetes/seconde, du plus prudent au plus agressif.
const STEPS = [0.8, 1.2, 1.6, 2.0, 2.5];
const STEP_SECONDS = 75;

const THEATERS = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, 'theaters.json'), 'utf8')).theaters.map((t) => t.id);
  } catch {
    return ['C0026', 'C0060', 'C0103', 'C0116', 'C0125'];
  }
})();

const log = (m) => console.log(`[${new Date().toLocaleTimeString('fr-FR')}] ${m}`);

let cursor = 0;
function nextUrl() {
  const id = THEATERS[cursor++ % THEATERS.length];
  const d = new Date();
  d.setDate(d.getDate() + (cursor % 5));
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `https://www.allocine.fr/_/showtimes/theater-${id}/d-${date}/`;
}

async function probe() {
  const res = await fetch(nextUrl(), {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'fr-FR,fr;q=0.9',
      'X-Requested-With': 'XMLHttpRequest',
    },
    signal: AbortSignal.timeout(20000),
  });
  await res.arrayBuffer(); // vider le corps pour liberer la connexion
  return res.status;
}

let best = 0;
outer:
for (const rate of STEPS) {
  const gap = 1000 / rate;
  const total = Math.round(rate * STEP_SECONDS);
  log(`palier ${rate} req/s — ${total} requetes sur ${STEP_SECONDS}s...`);

  let ok = 0;
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    const target = t0 + i * gap;
    const wait = target - Date.now();
    if (wait > 0) await sleep(wait);

    let status;
    try {
      status = await probe();
    } catch {
      continue; // incident reseau : ne compte pas comme un blocage
    }
    if (status === 429 || status === 403) {
      log(`  BLOQUE apres ${ok} requetes a ${rate} req/s`);
      break outer;
    }
    ok++;
  }
  best = rate;
  log(`  OK : ${ok} requetes passees a ${rate} req/s`);
}

if (!best) {
  log('Bloque des le premier palier — on reste sur un debit tres prudent.');
}

// Marge de securite volontairement large : les paliers ci-dessus durent 75 s,
// or AlloCine tolere bien plus en rafale qu'en continu. Mesure du 31/07/2026 :
// 1,6 req/s tenu 75 s, mais 1,12 req/s (70 % de 1,6) s'est fait bloquer apres
// 6 min d'affilee sur une reconstruction complete. Le debit reste stable une
// fois retombe vers 0,6 req/s — d'ou ce facteur 0,4.
const safe = Math.max(0.4, +(best * 0.4).toFixed(2));
const conf = {
  measuredAt: new Date().toISOString(),
  highestRateHeld: best,
  safeRatePerSecond: safe,
  intervalMs: Math.round(1000 / safe),
  budgetPer10min: Math.round(safe * 600),
};
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'rate.json'), JSON.stringify(conf, null, 1));

log(`Palier le plus haut tenu : ${best} req/s`);
log(`Retenu (marge 30 %) : ${safe} req/s -> ${conf.intervalMs} ms entre requetes, ${conf.budgetPer10min}/10 min`);
log(`Ecrit dans data/rate.json`);
