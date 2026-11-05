// Accès depuis le téléphone, partout, via Tailscale.
//
// Tailscale relie le PC et le téléphone dans un réseau privé ; « tailscale serve »
// publie l'app sur une adresse HTTPS de ce réseau (https://<pc>.<réseau>.ts.net),
// visible uniquement par TES appareils. HTTPS est indispensable : c'est ce qui
// permet à l'iPhone d'installer l'app sur l'écran d'accueil et de garder une
// copie hors ligne des séances.
//
// Ce module :
// - lit l'état de Tailscale (installé ? connecté ? adresse ? publication active ?) ;
// - gère le réglage « toujours allumé » (data/settings.json) : le serveur ne
//   s'arrête plus quand la fenêtre est fermée, et il démarre avec Windows grâce
//   à un raccourci dans le dossier Démarrage — créé et retiré par ce réglage.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const REGLAGES = path.join(DATA, 'settings.json');
const NOM_DEMARRAGE = 'Cine IDF (serveur).lnk';

const lire = (f) => {
  try {
    const raw = fs.readFileSync(f, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return null;
  }
};

export function reglages() {
  return { toujoursActif: false, ...(lire(REGLAGES) || {}) };
}

function ecrireReglages(r) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(REGLAGES, JSON.stringify(r, null, 1));
}

/** tailscale.exe (Windows) ou tailscale (Mac/Linux), ou null s'il est absent. */
function binaireTailscale() {
  const candidats = process.platform === 'win32'
    ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
    : ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/usr/bin/tailscale',
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  return candidats.find((c) => fs.existsSync(c)) || null;
}

const lancer = (bin, args) => new Promise((ok) => {
  execFile(bin, args, { timeout: 8000, windowsHide: true }, (err, stdout) => ok(err ? null : stdout));
});

/**
 * État de Tailscale, pour guider pas à pas dans l'app.
 * etape : 'installer' | 'connecter' | 'publier' | 'pret'
 */
export async function etatTailscale(port) {
  const bin = binaireTailscale();
  if (!bin) return { etape: 'installer' };
  const brut = await lancer(bin, ['status', '--json']);
  let st = null;
  try { st = brut ? JSON.parse(brut) : null; } catch { /* sortie illisible */ }
  if (!st || st.BackendState !== 'Running' || !st.Self?.DNSName) return { etape: 'connecter' };
  const nom = st.Self.DNSName.replace(/\.$/, '');
  const adresse = `https://${nom}`;
  const telephones = Object.values(st.Peer || {})
    .filter((p) => /ios|android/i.test(p.OS || ''))
    .map((p) => ({ nom: p.HostName, enLigne: Boolean(p.Online) }));

  // La publication « serve » pointe-t-elle bien vers l'app ?
  const serve = await lancer(bin, ['serve', 'status', '--json']);
  let publie = false;
  try {
    const conf = serve ? JSON.parse(serve) : {};
    publie = JSON.stringify(conf).includes(`127.0.0.1:${port}`) || JSON.stringify(conf).includes(`localhost:${port}`);
  } catch { /* pas de publication */ }
  return { etape: publie ? 'pret' : 'publier', adresse, telephones, commande: `tailscale serve --bg ${port}` };
}

/** Publie l'app sur l'adresse HTTPS Tailscale (demande explicite depuis l'app). */
export async function publierTailscale(port) {
  const bin = binaireTailscale();
  if (!bin) throw new Error('Tailscale n\'est pas installé');
  const sortie = await new Promise((ok) => {
    execFile(bin, ['serve', '--bg', String(port)], { timeout: 20000, windowsHide: true },
      (err, stdout, stderr) => ok({ err, texte: `${stdout}\n${stderr}` }));
  });
  if (sortie.err) {
    // Cas fréquent : HTTPS pas encore activé dans la console Tailscale.
    const lien = (sortie.texte.match(/https:\/\/login\.tailscale\.com\/\S+/) || [])[0];
    throw new Error(lien
      ? `active d'abord HTTPS dans Tailscale : ${lien}`
      : (sortie.texte.trim().split('\n').pop() || sortie.err.message));
  }
  return etatTailscale(port);
}

/* ------------------------------------------------------------ toujours allumé */

const dossierDemarrage = () =>
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');

/**
 * Le lanceur : un petit script .vbs lance le serveur sans aucune fenêtre et le
 * relance s'il plante (code de sortie non nul). Un arrêt normal (code 0 :
 * inactivité, serveur déjà lancé) met fin au script.
 */
export function ecrireLanceur() {
  if (process.platform !== 'win32') return null;
  const vbs = path.join(ROOT, 'serveur-cache.vbs');
  // UTF-16 avec BOM : wscript lit alors correctement un chemin accentué
  // (en UTF-8 sans BOM, il le prendrait pour de l'ANSI).
  const contenu = '﻿' + [
    "' Lance le serveur Cine IDF sans fenetre (demarrage de Windows, mode toujours allume).",
    "' S'il plante, il repart tout seul apres 10 secondes.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${ROOT}"`,
    'Do',
    `  code = sh.Run("""${process.execPath}"" src\\server.js", 0, True)`,
    '  If code = 0 Then Exit Do',
    '  WScript.Sleep 10000',
    'Loop',
    '',
  ].join('\r\n');
  let actuel = null;
  try { actuel = fs.readFileSync(vbs, 'utf16le'); } catch { /* pas encore créé */ }
  if (actuel !== contenu) fs.writeFileSync(vbs, contenu, 'utf16le');
  return vbs;
}

/** Démarrage avec Windows : un raccourci vers le lanceur, dans le dossier Démarrage. */
function installerDemarrage() {
  if (process.platform !== 'win32') return null;
  const vbs = ecrireLanceur();
  const lien = path.join(dossierDemarrage(), NOM_DEMARRAGE);
  const ps = [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lien.replace(/'/g, "''")}')`,
    `$s.TargetPath = "$env:SystemRoot\\System32\\wscript.exe"`,
    `$s.Arguments = '"${vbs.replace(/'/g, "''")}"'`,
    `$s.WorkingDirectory = '${ROOT.replace(/'/g, "''")}'`,
    `$s.Description = 'Serveur Cine IDF (pour le telephone)'`,
    '$s.Save()',
  ].join('; ');
  return new Promise((ok, ko) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 },
      (err) => (err ? ko(err) : ok(lien)));
  });
}

function retirerDemarrage() {
  if (process.platform !== 'win32') return;
  fs.rmSync(path.join(dossierDemarrage(), NOM_DEMARRAGE), { force: true });
  fs.rmSync(path.join(ROOT, 'serveur-cache.vbs'), { force: true });
}

export async function definirToujoursActif(actif) {
  const r = { ...reglages(), toujoursActif: Boolean(actif) };
  if (r.toujoursActif) await installerDemarrage();
  else retirerDemarrage();
  ecrireReglages(r);
  return r;
}

export const demarrageInstalle = () =>
  process.platform === 'win32' && fs.existsSync(path.join(dossierDemarrage(), NOM_DEMARRAGE));
