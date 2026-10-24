// Fabrique le zip a envoyer a quelqu'un :
//   npm run zip                              -> cine-idf-windows.zip + cine-idf-mac.zip
//   node src/make-zip.js --os=mac sortie.zip -> un seul zip, pour un systeme
//   node src/make-zip.js --os=tous sortie.zip -> un zip avec les deux
//
// - jamais data/ (tes seances, favoris, watchlist) ni .claude/ ni .git/ ;
// - les scripts Mac (*.command, *.sh) gardent la permission « executable » :
//   un zip fait par l'Explorateur Windows la perd, et sur Mac le double-clic sur
//   « Installer Cine IDF.command » echouerait alors (« droits d'acces insuffisants »).
// Zip ecrit a la main (format simple, zlib fourni par Node) : aucune dependance.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUS = new Set(['data', '.claude', '.git', 'node_modules']);
const EXECUTABLE = /\.(command|sh)$/;
const args = process.argv.slice(2);
const cible = (args.find((a) => a.startsWith('--os=')) || '').slice(5);
const sortieDemandee = args.find((a) => !a.startsWith('--'));
// Fichiers propres a un systeme : inutiles (et deroutants) dans le zip de l'autre.
const SEULEMENT_WINDOWS = /\.(cmd|ps1|ico)$/;
const SEULEMENT_MAC = /\.(command|sh)$/;
const garder = (rel, systeme) =>
  systeme === 'windows' ? !SEULEMENT_MAC.test(rel) : systeme === 'mac' ? !SEULEMENT_WINDOWS.test(rel) : true;

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function fichiers(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!rel && EXCLUS.has(e.name)) continue;
    if (e.name.endsWith('.tmp')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...fichiers(path.join(dir, e.name), r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** Date au format DOS (zip). */
function dosDate(d) {
  const t = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const j = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { t, j };
}

function fabriquer(sortie, systeme) {
const locaux = [];
const centraux = [];
let decalage = 0;
const liste = fichiers(ROOT).sort().filter((rel) => garder(rel, systeme));

for (const rel of liste) {
  const nom = Buffer.from(`cine-idf/${rel}`, 'utf8');
  const brut = fs.readFileSync(path.join(ROOT, rel));
  const comprime = zlib.deflateRawSync(brut, { level: 9 });
  const crc = crc32(brut);
  const { t, j } = dosDate(fs.statSync(path.join(ROOT, rel)).mtime);
  const mode = EXECUTABLE.test(rel) ? 0o100755 : 0o100644;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);          // version requise
  local.writeUInt16LE(0x0800, 6);      // noms en UTF-8
  local.writeUInt16LE(8, 8);           // deflate
  local.writeUInt16LE(t, 10);
  local.writeUInt16LE(j, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comprime.length, 18);
  local.writeUInt32LE(brut.length, 22);
  local.writeUInt16LE(nom.length, 26);
  locaux.push(local, nom, comprime);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4); // fabrique « Unix » : les permissions sont lues
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(t, 12);
  central.writeUInt16LE(j, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comprime.length, 20);
  central.writeUInt32LE(brut.length, 24);
  central.writeUInt16LE(nom.length, 28);
  central.writeUInt32LE((mode << 16) >>> 0, 38); // permissions Unix
  central.writeUInt32LE(decalage, 42);
  centraux.push(central, nom);

  decalage += local.length + nom.length + comprime.length;
}

const tailleCentral = centraux.reduce((n, b) => n + b.length, 0);
const fin = Buffer.alloc(22);
fin.writeUInt32LE(0x06054b50, 0);
fin.writeUInt16LE(liste.length, 8);
fin.writeUInt16LE(liste.length, 10);
fin.writeUInt32LE(tailleCentral, 12);
fin.writeUInt32LE(decalage, 16);

fs.writeFileSync(sortie, Buffer.concat([...locaux, ...centraux, fin]));
const exec = liste.filter((r) => EXECUTABLE.test(r));
console.log(`${sortie} : ${liste.length} fichiers, ${Math.round(fs.statSync(sortie).size / 1024)} Ko${exec.length ? ` · executables : ${exec.join(', ')}` : ''}`);
}

const bureau = path.join(os.homedir(), 'Desktop');
if (cible) {
  fabriquer(path.resolve(sortieDemandee || path.join(bureau, `cine-idf-${cible}.zip`)), cible);
} else {
  const dossier = sortieDemandee ? path.resolve(sortieDemandee) : bureau;
  fabriquer(path.join(dossier, 'cine-idf-windows.zip'), 'windows');
  fabriquer(path.join(dossier, 'cine-idf-mac.zip'), 'mac');
}
