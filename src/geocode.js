// Ajoute latitude/longitude a chaque cinema de data/theaters.json.
//
//   node src/geocode.js [--force]
//
// Utilise la Base Adresse Nationale (api-adresse.data.gouv.fr) : service public,
// gratuit, sans cle, et surtout capable de traiter tout le fichier en UNE requete.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data', 'theaters.json');
const API = 'https://api-adresse.data.gouv.fr/search/csv/';
const FORCE = process.argv.includes('--force');

const log = (m) => console.log(`[${new Date().toLocaleTimeString('fr-FR')}] ${m}`);

/* ------------------------------------------------------------------- CSV */

const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/** Analyseur CSV minimal, suffisant pour la reponse de l'API (guillemets standard). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Envoie un lot au geocodeur. `parts` designe les colonnes a concatener pour
 * former l'adresse recherchee ; le code postal sert de filtre.
 */
async function geocodeBatch(rows, parts) {
  const header = ['id', 'adresse', 'cp', 'ville'];
  const csv = [header.join(',')]
    .concat(rows.map((r) => [r.id, r.adresse, r.cp, r.ville].map(csvEscape).join(',')))
    .join('\n');

  const form = new FormData();
  form.append('data', new Blob([csv], { type: 'text/csv' }), 'theaters.csv');
  for (const p of parts) form.append('columns', p);
  form.append('postcode', 'cp');

  const res = await fetch(API, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`API adresse : HTTP ${res.status}`);

  const table = parseCsv(await res.text());
  const head = table.shift();
  const col = (name) => head.indexOf(name);
  const [iId, iLon, iLat, iScore] = ['id', 'longitude', 'latitude', 'result_score'].map(col);

  const out = new Map();
  for (const r of table) {
    // Attention : Number('') vaut 0, donc une colonne vide passerait pour des
    // coordonnees valides au large de l'Afrique. On teste la chaine brute.
    if (!r[iId] || !r[iLat]?.trim() || !r[iLon]?.trim()) continue;
    const lat = Number(r[iLat]);
    const lon = Number(r[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.set(r[iId], { lat, lon, score: Number(r[iScore]) || 0 });
  }
  return out;
}

/** Recherche unitaire, une adresse a la fois. Renvoie null si rien de fiable. */
async function searchOne(query) {
  try {
    const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(query)}&limit=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const [feature] = (await res.json()).features ?? [];
    const [lon, lat] = feature?.geometry?.coordinates ?? [];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon, score: feature.properties?.score ?? 0 };
  } catch {
    return null;
  }
}

const STREET = /\b(rue|avenue|av\.?|bd|boulevard|place|pl\.?|esplanade|cours|quai|all[ée]e|chemin|route|impasse|square|mail|promenade|passage|voie|parvis)\b/i;

/**
 * Les adresses d'AlloCine sont des notices, pas des adresses postales :
 * "A l'interieur du Grand Palais: a l'angle du Cours de la Reine ... / Entree
 * par les marches". On isole le premier fragment qui ressemble a une voie.
 */
function cleanAddress(address) {
  const base = address.replace(/\b\d{5}\b.*$/, '').replace(/\s+/g, ' ').trim();
  const parts = base.split(/\s*[/:;]\s*|\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  const street = parts.find((p) => STREET.test(p)) || parts[0] || base;

  return street
    .replace(/^(?:a|à)\s+l['’]?\s*(?:intérieur|interieur|angle)\s+(?:du|de la|des|de l['’])\s*/i, '')
    .replace(/\b(?:accès|acces|entrée|entree|caisses?|salles?|métro|metro)\b.*$/i, '')
    .replace(/[,\s]+$/, '')
    .trim();
}

/* ------------------------------------------------------------------ main */

export async function geocodeTheaters({ force = false } = {}) {
  const db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const theaters = db.theaters;

  // --force doit vraiment repartir de zero, sinon d'anciennes coordonnees
  // erronees survivent a la reexecution.
  if (force) for (const t of theaters) { delete t.lat; delete t.lon; delete t.geo; }

  const todo = theaters.filter((t) => !Number.isFinite(t.lat));
  if (!todo.length) {
    log(`${theaters.length} cinemas deja geolocalises.`);
    return;
  }
  log(`geolocalisation de ${todo.length} cinemas...`);

  const rows = todo.map((t) => ({
    id: t.id,
    adresse: cleanAddress(t.address),
    cp: t.postalCode,
    ville: t.city.replace(/^Paris \d+(er|e)$/, 'Paris'),
  }));

  const precise = await geocodeBatch(rows, ['adresse', 'ville']);
  log(`  ${precise.size}/${todo.length} trouves a l'adresse exacte`);

  // Repli sur la commune. On interroge "75008 Paris" et pas "Paris" : sinon
  // toutes les salles parisiennes non reconnues atterrissent au meme point,
  // et le tri par distance devient un mensonge.
  const missing = rows.filter((r) => {
    const hit = precise.get(r.id);
    return !hit || hit.score < 0.4;
  });
  // Requetes unitaires : en mode CSV, le filtre par code postal ecrase la
  // recherche et renvoie le centre de Paris pour tous les arrondissements.
  // A ce volume (une poignee), une requete par salle ne coute rien.
  const approx = new Map();
  for (const r of missing) {
    const hit = await searchOne(`${r.cp} ${r.ville}`);
    if (hit) approx.set(r.id, hit);
  }
  if (missing.length) log(`  ${approx.size}/${missing.length} rattrapes a la commune / l'arrondissement`);

  let ok = 0;
  for (const t of theaters) {
    const hit = precise.get(t.id);
    if (hit && hit.score >= 0.4) {
      Object.assign(t, { lat: +hit.lat.toFixed(6), lon: +hit.lon.toFixed(6), geo: 'exact' });
      ok++;
    } else if (approx.has(t.id)) {
      const a = approx.get(t.id);
      Object.assign(t, { lat: +a.lat.toFixed(6), lon: +a.lon.toFixed(6), geo: 'ville' });
      ok++;
    }
  }

  // Poignee de cas restants (lieux-dits qui ne sont pas des communes) : une
  // requete unitaire chacun, ca ne coute rien a ce volume.
  for (const t of theaters.filter((x) => !Number.isFinite(x.lat))) {
    const hit = await searchOne(`${t.city} ${t.postalCode}`.trim());
    if (hit) {
      Object.assign(t, { lat: +hit.lat.toFixed(6), lon: +hit.lon.toFixed(6), geo: 'ville' });
      ok++;
      log(`  rattrape a l'unite : ${t.name}`);
    } else {
      log(`  ! sans coordonnees : ${t.name} (${t.address})`);
    }
  }

  db.geocodedAt = new Date().toISOString();
  fs.writeFileSync(FILE, JSON.stringify(db, null, 1));

  const sansCoord = theaters.filter((t) => !Number.isFinite(t.lat)).length;
  log(`${ok}/${theaters.length} cinemas geolocalises${sansCoord ? ` (${sansCoord} sans coordonnees)` : ''}.`);
}

// Lance uniquement en execution directe (pas quand scrape.js l'importe).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  geocodeTheaters({ force: FORCE }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
