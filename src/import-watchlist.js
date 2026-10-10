// Detection et lecture automatique d'un export Letterboxd depose dans le
// dossier Telechargements.
//
// L'export est un .zip contenant watchlist.csv. Node sait deja decompresser
// (zlib), il ne manque que la lecture de l'index du zip : c'est court, et ca
// evite d'ajouter une dependance a une app qui n'en a aucune.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/** Dossiers ou peut atterrir un telechargement, selon la configuration. */
function dossiersTelechargement() {
  const home = os.homedir();
  return [
    path.join(home, 'Downloads'),
    path.join(home, 'Téléchargements'),
    process.env.OneDrive ? path.join(process.env.OneDrive, 'Downloads') : null,
  ].filter((d) => d && fs.existsSync(d));
}

/**
 * Cherche l'export Letterboxd le plus recent : soit le zip complet, soit un
 * watchlist.csv deja extrait.
 */
export function trouverExport() {
  const candidats = [];
  for (const dossier of dossiersTelechargement()) {
    let fichiers = [];
    try {
      fichiers = fs.readdirSync(dossier);
    } catch { continue; }

    for (const nom of fichiers) {
      const bas = nom.toLowerCase();
      const estZip = bas.startsWith('letterboxd-') && bas.endsWith('.zip');
      const estCsv = bas === 'watchlist.csv';
      if (!estZip && !estCsv) continue;
      try {
        const complet = path.join(dossier, nom);
        candidats.push({ chemin: complet, nom, mtime: fs.statSync(complet).mtimeMs });
      } catch { /* fichier disparu entre-temps */ }
    }
  }
  candidats.sort((a, b) => b.mtime - a.mtime);
  return candidats[0] ?? null;
}

/* -------------------------------------------------------------- lecture zip */

const SIG_FIN = 0x06054b50;   // fin de l'index central
const SIG_ENTREE = 0x02014b50; // entree de l'index
const SIG_LOCAL = 0x04034b50;  // en-tete local d'un fichier

/** Extrait un fichier d'une archive zip, par nom (insensible a la casse). */
function extraireDuZip(buf, cible) {
  // L'index central est en fin de fichier ; on remonte pour trouver sa signature.
  let fin = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === SIG_FIN) { fin = i; break; }
  }
  if (fin < 0) throw new Error('archive illisible');

  const nbEntrees = buf.readUInt16LE(fin + 10);
  let pos = buf.readUInt32LE(fin + 16);

  for (let n = 0; n < nbEntrees; n++) {
    if (buf.readUInt32LE(pos) !== SIG_ENTREE) break;
    const methode = buf.readUInt16LE(pos + 10);
    const tailleCompressee = buf.readUInt32LE(pos + 20);
    const lgNom = buf.readUInt16LE(pos + 28);
    const lgExtra = buf.readUInt16LE(pos + 30);
    const lgCommentaire = buf.readUInt16LE(pos + 32);
    const debutLocal = buf.readUInt32LE(pos + 42);
    const nom = buf.toString('utf8', pos + 46, pos + 46 + lgNom);

    if (path.basename(nom).toLowerCase() === cible.toLowerCase()) {
      if (buf.readUInt32LE(debutLocal) !== SIG_LOCAL) throw new Error('en-tete local invalide');
      // Les longueurs de l'en-tete local peuvent differer de celles de l'index.
      const lgNomL = buf.readUInt16LE(debutLocal + 26);
      const lgExtraL = buf.readUInt16LE(debutLocal + 28);
      const debut = debutLocal + 30 + lgNomL + lgExtraL;
      const donnees = buf.subarray(debut, debut + tailleCompressee);
      if (methode === 0) return donnees;             // stocke tel quel
      if (methode === 8) return zlib.inflateRawSync(donnees); // deflate
      throw new Error(`compression non geree (${methode})`);
    }
    pos += 46 + lgNom + lgExtra + lgCommentaire;
  }
  return null;
}

/** Renvoie le contenu texte de watchlist.csv, depuis un zip ou un csv. */
export function lireWatchlist(chemin) {
  const buf = fs.readFileSync(chemin);
  if (chemin.toLowerCase().endsWith('.zip')) {
    const csv = extraireDuZip(buf, 'watchlist.csv');
    if (!csv) throw new Error("ce zip ne contient pas de watchlist.csv");
    return csv.toString('utf8');
  }
  return buf.toString('utf8');
}
