// Acces aux donnees publiques d'AlloCine (pages de listing + endpoint JSON /_/showtimes).
// Aucune cle d'API : ce sont les memes requetes que celles que fait le site web.
//
// AlloCine est derriere Cloudflare : au-dela d'un certain debit on recoit des 429
// "cf-mitigated: challenge". D'ou le regulateur de debit adaptatif ci-dessous et
// le cookie jar (__cf_bm), qui reproduisent le comportement d'un navigateur.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const ZONES = [
  { dept: '75', name: 'Paris', url: 'https://www.allocine.fr/salle/cinema/ville-115755/' },
  { dept: '77', name: 'Seine-et-Marne', url: 'https://www.allocine.fr/salle/cinema/departement-83166/' },
  { dept: '78', name: 'Yvelines', url: 'https://www.allocine.fr/salle/cinema/departement-83167/' },
  { dept: '91', name: 'Essonne', url: 'https://www.allocine.fr/salle/cinema/departement-83168/' },
  { dept: '92', name: 'Hauts-de-Seine', url: 'https://www.allocine.fr/salle/cinema/departement-83169/' },
  { dept: '93', name: 'Seine-Saint-Denis', url: 'https://www.allocine.fr/salle/cinema/departement-83170/' },
  { dept: '94', name: 'Val-de-Marne', url: 'https://www.allocine.fr/salle/cinema/departement-83171/' },
  { dept: '95', name: "Val-d'Oise", url: 'https://www.allocine.fr/salle/cinema/departement-83172/' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- cookie jar */

const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

function storeCookies(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

/* --------------------------------------------------------- debit adaptatif */

// Debit mesure par `node src/calibrate.js` : AlloCine tolere environ
// 100 requetes/minute et coupe au-dela. Les valeurs ci-dessous sont la
// solution de repli ; rate.json, s'il existe, les remplace.
export const throttle = {
  interval: 900,       // ms entre deux requetes, toutes taches confondues
  min: 900,
  max: 4000,
  windowMs: 600000,    // fenetre glissante
  budget: 660,         // requetes autorisees par fenetre
  hits: [],            // horodatages des requetes de la fenetre courante
  nextSlot: 0,
  pausedUntil: 0,
  streak: 0,
  blocked: 0,          // nombre de blocages consecutifs non resolus
  onEvent: null,       // callback(type, detail) pour journaliser
};

/** Applique le debit mesure par calibrate.js. */
export function configureThrottle({ intervalMs, budgetPer10min } = {}) {
  if (intervalMs > 0) {
    throttle.interval = intervalMs;
    throttle.min = intervalMs;
    throttle.max = Math.max(intervalMs * 4, 4000);
  }
  if (budgetPer10min > 0) throttle.budget = budgetPer10min;
}

async function takeSlot() {
  const t = throttle;
  for (;;) {
    const now = Date.now();
    while (t.hits.length && t.hits[0] < now - t.windowMs) t.hits.shift();

    if (t.hits.length >= t.budget) {
      const wait = Math.max(1000, t.hits[0] + t.windowMs - now + 500);
      t.onEvent?.('budget', { wait });
      await sleep(Math.min(wait, 30000));
      continue;
    }
    const at = Math.max(now, t.nextSlot, t.pausedUntil);
    t.nextSlot = at + t.interval;
    if (at > now) await sleep(at - now);
    t.hits.push(Date.now());
    return;
  }
}

function onSuccess() {
  throttle.blocked = 0;
  if (++throttle.streak >= 40 && throttle.interval > throttle.min) {
    throttle.streak = 0;
    throttle.interval = Math.max(throttle.min, Math.round(throttle.interval * 0.9));
  }
}

function onThrottled() {
  const t = throttle;
  t.streak = 0;

  // Les requetes en vol prennent toutes le 429 en meme temps : c'est UN blocage,
  // pas trois. Sans ce garde-fou, trois workers suffisaient a atteindre le seuil
  // d'abandon en deux vagues et a interrompre une recuperation qui allait bien.
  if (Date.now() < t.pausedUntil) return;
  t.blocked++;
  t.interval = Math.min(t.max, Math.round(t.interval * 1.5));
  t.budget = Math.max(120, Math.round(t.budget * 0.75));
  t.hits = [];

  // Un blocage se resorbe en quelques minutes : on tente court d'abord.
  const pause = [120000, 300000, 600000][Math.min(t.blocked - 1, 2)];
  t.pausedUntil = Date.now() + pause;
  t.nextSlot = t.pausedUntil;
  t.onEvent?.('throttled', { pause, interval: t.interval, budget: t.budget });
}

export class BlockedError extends Error {
  constructor() {
    super('AlloCine bloque les requetes (Cloudflare). Reessaie plus tard.');
    this.name = 'BlockedError';
  }
}

/* ------------------------------------------------------------- requetes */

export async function request(url, { json = false, referer, attempts = 6 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (throttle.blocked >= 4) throw new BlockedError();
    await takeSlot();

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: json ? 'application/json, text/javascript, */*; q=0.01' : 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
          'Sec-CH-UA': '"Chromium";v="120", "Not:A-Brand";v="24", "Google Chrome";v="120"',
          'Sec-CH-UA-Mobile': '?0',
          'Sec-CH-UA-Platform': '"Windows"',
          'Sec-Fetch-Dest': json ? 'empty' : 'document',
          'Sec-Fetch-Mode': json ? 'cors' : 'navigate',
          'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
          ...(json ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
          ...(referer ? { Referer: referer } : {}),
          ...(jar.size ? { Cookie: cookieHeader() } : {}),
        },
        signal: AbortSignal.timeout(30000),
      });
      storeCookies(res);

      if (res.status === 429 || res.status === 403 || res.status === 503) {
        onThrottled();
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(1000 * (i + 1));
        continue;
      }
      onSuccess();
      if (!res.ok) return null; // 404 : la ressource n'existe pas
      return json ? await res.json() : await res.text();
    } catch (err) {
      if (err instanceof BlockedError) throw err;
      lastErr = err;
      await sleep(800 * (i + 1));
    }
  }
  throw lastErr ?? new Error('echec');
}

/** Visite une page normale pour recuperer les cookies Cloudflare avant les appels JSON. */
export async function warmUp() {
  jar.clear();
  await request('https://www.allocine.fr/salle/');
}

/* --------------------------------------------------------------- parsing */

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

const titleCase = (s) =>
  s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, sep, c) => sep + c.toUpperCase());

/**
 * Extrait code postal + commune d'une adresse libre.
 * Les adresses d'AlloCine sont irregulieres : commune repetee
 * ("... 91290 Arpajon 91290 Arpajon"), casse aleatoire ("MEUDON LA FORET"),
 * arrondissements ecrits de cinq facons differentes. On s'appuie sur le
 * DERNIER code postal trouve, puis on normalise.
 */
function parseLocality(address) {
  const codes = [...address.matchAll(/\b(\d{5})\b/g)];
  const last = codes.at(-1);
  if (!last) return { postalCode: '', city: '' };

  const postalCode = last[1];
  let city = address.slice(last.index + 5).replace(/\s+/g, ' ').trim();
  city = city.replace(/\bcedex\b.*$/i, '').replace(/[,;]+$/, '').trim();

  // Paris : on reconstruit l'arrondissement depuis le code postal, c'est le seul
  // repere fiable — et ca rend le filtre par ville reellement utilisable.
  if (/^75\d{3}$/.test(postalCode)) {
    const n = Number(postalCode.slice(3));
    if (n >= 1 && n <= 20) return { postalCode, city: `Paris ${n}${n === 1 ? 'er' : 'e'}` };
    return { postalCode, city: 'Paris' };
  }

  if (!city) return { postalCode, city: '' };
  if (city === city.toUpperCase()) city = titleCase(city);
  return { postalCode, city };
}

// Chaque fiche cinema du listing expose un <span data-theater='{"id":..,"name":..}'>
// suivi d'une <address> : couple stable et sans ambiguite.
function parseTheaterList(html, dept) {
  const out = [];
  for (const m of html.matchAll(/data-theater="([^"]+)"/g)) {
    let info;
    try {
      info = JSON.parse(decodeEntities(m[1]));
    } catch {
      continue;
    }
    if (!info?.id) continue;

    const rest = html.slice(m.index, m.index + 4000);
    const addrMatch = rest.match(/<address[^>]*>([\s\S]*?)<\/address>/);
    const address = addrMatch
      ? decodeEntities(addrMatch[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
      : '';

    const { postalCode, city } = parseLocality(address);
    out.push({
      id: info.id,
      name: decodeEntities(info.name || '').trim(),
      address,
      postalCode,
      city,
      dept: postalCode ? postalCode.slice(0, 2) : dept,
      url: `https://www.allocine.fr/seance/salle_gen_csalle=${info.id}.html`,
    });
  }
  return out;
}

function lastPage(html) {
  let max = 1;
  for (const m of html.matchAll(/[?&]page=(\d+)/g)) max = Math.max(max, Number(m[1]));
  return Math.min(max, 40); // garde-fou
}

/** Liste tous les cinemas d'une zone (toutes pages confondues). */
export async function fetchTheatersForZone(zone) {
  const first = await request(zone.url);
  if (!first) return [];
  const theaters = parseTheaterList(first, zone.dept);

  for (let p = 2, pages = lastPage(first); p <= pages; p++) {
    const html = await request(`${zone.url}?page=${p}`, { referer: zone.url });
    if (html) theaters.push(...parseTheaterList(html, zone.dept));
  }
  return theaters;
}

/**
 * Seances d'un cinema pour une date (YYYY-MM-DD). Suit la pagination.
 * `nextDate` est renseigne par AlloCine quand la salle ne rouvre que plus tard :
 * on s'en sert pour ne pas la reinterroger pour les jours intermediaires.
 */
export async function fetchShowtimes(theaterId, date) {
  const base = `https://www.allocine.fr/_/showtimes/theater-${theaterId}/d-${date}/`;
  const referer = `https://www.allocine.fr/seance/salle_gen_csalle=${theaterId}.html`;

  const first = await request(base, { json: true, referer });
  if (!first || first.error || !Array.isArray(first.results) || !first.results.length) {
    return { results: [], nextDate: first?.nextDate ?? null };
  }

  const results = [...first.results];
  const declared = first.pagination?.totalPages ?? 1;
  const perPage = first.pagination?.itemsPerPage || 15;
  // On ne se fie pas qu'au nombre de pages annonce : AlloCine l'a deja donne
  // faux (1 au lieu de 3). Tant que la page precedente etait pleine, il peut en
  // rester une — ca ne coute une requete de plus que dans ce cas precis.
  let last = first.results.length;
  for (let p = 2; p <= 20 && (p <= declared || last >= perPage); p++) {
    const page = await request(`${base}?page=${p}`, { json: true, referer });
    last = page?.results?.length ?? 0;
    if (!last) break;
    results.push(...page.results);
  }
  return { results, nextDate: null };
}
