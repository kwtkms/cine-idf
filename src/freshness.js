// Regles de fraicheur, partagees par le scraper (quoi retelecharger) et le
// serveur (faut-il lancer une mise a jour ?). Un seul endroit, sinon les deux
// finissent par diverger.
import fs from 'node:fs';
import path from 'node:path';

/** Sous cette fraction d'une journee normale, un jour est « creux » : programme pas encore publie. */
export const SPARSE_RATIO = 0.4;

/**
 * Age maximal d'une journee, en heures.
 * - aujourd'hui : 4 h (ajouts et annulations de derniere minute) ;
 * - jour creux : 2 h — les salles publient la semaine suivante le lundi ou le
 *   mardi, au fil de la journee ; il faut la voir apparaitre sans attendre ;
 * - demain : 8 h — des films s'ajoutent encore la veille (vu le 16/09/2026 aux
 *   Halles) ; au-dela : 24 h.
 */
export const freshHours = (offset, sparse) => (offset === 0 ? 4 : sparse ? 2 : offset === 1 ? 8 : 24);

export function localDate(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const readDay = (dir, date) => {
  try {
    const raw = fs.readFileSync(path.join(dir, `day-${date}.json`), 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return null;
  }
};

/** Volume d'une journee normalement publiee, pour reperer les jours creux. */
export function referenceVolume(dir, dates) {
  let ref = 0;
  for (const date of dates) ref = Math.max(ref, readDay(dir, date)?.counts?.shows ?? 0);
  return ref;
}

/** Jours de la fenetre a (re)telecharger : absents, incomplets ou trop vieux. */
export function staleDays(dir, days = 5) {
  const dates = Array.from({ length: days }, (_, i) => localDate(i));
  const ref = referenceVolume(dir, dates);
  return dates.filter((date, offset) => {
    const d = readDay(dir, date);
    if (!d?.complete || !d.fetchedAt) return true;
    const ageH = (Date.now() - Date.parse(d.fetchedAt)) / 3600000;
    const sparse = (d.counts?.shows ?? 0) < SPARSE_RATIO * ref;
    return ageH >= freshHours(offset, sparse);
  });
}
