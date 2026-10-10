/* Marque-page « Envoyer vers Ciné IDF ».
   S'exécute sur ta page watchlist Letterboxd, dans ton navigateur : le challenge
   Cloudflare y est déjà résolu et tu es connecté, donc les films sont lisibles.
   Il fait défiler la page pour tout charger, puis envoie titres + années à l'app. */
(async () => {
  const APP = 'http://localhost:4173';
  const bulle = document.createElement('div');
  bulle.style.cssText = 'position:fixed;z-index:99999;right:16px;bottom:16px;background:#161b23;color:#fff;'
    + 'padding:12px 16px;border-radius:10px;font:14px system-ui;box-shadow:0 6px 24px rgba(0,0,0,.4)';
  document.body.appendChild(bulle);
  const dire = (t) => { bulle.textContent = t; };

  if (!/\/watchlist\/?$/.test(location.pathname)) {
    dire('Ouvre ta page watchlist puis reclique.');
    setTimeout(() => bulle.remove(), 5000);
    return;
  }

  // Défilement jusqu'à ce que le nombre de vignettes se stabilise.
  const compter = () => document.querySelectorAll('li.griditem').length;
  let precedent = -1;
  for (let i = 0; i < 60 && compter() !== precedent; i++) {
    precedent = compter();
    dire(`Chargement… ${precedent} films`);
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 1000));
  }

  const films = [...document.querySelectorAll('li.griditem')].map((li) => {
    const alt = li.querySelector('img[alt]')?.getAttribute('alt') || '';
    const m = alt.match(/^Poster for (.+) \((\d{4})\)$/);
    return { titre: m ? m[1] : alt.replace(/^Poster for /, '').trim(), annee: m ? Number(m[2]) : null };
  }).filter((f) => f.titre);

  const pseudo = location.pathname.split("/").filter(Boolean)[0] || null;

  if (!films.length) {
    dire('Aucun film trouvé sur cette page.');
    setTimeout(() => bulle.remove(), 6000);
    return;
  }

  dire(`Envoi de ${films.length} films…`);

  // Envoi direct, avec une limite de temps : certains navigateurs retiennent
  // indéfiniment un appel d'un site public vers une adresse locale.
  try {
    const r = await Promise.race([
      fetch(`${APP}/api/watchlist/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ films, pseudo }),
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('délai dépassé')), 4000)),
    ]);
    if (r.ok) {
      const d = await r.json();
      dire(`✓ ${d.recus} films envoyés à Ciné IDF`);
      setTimeout(() => bulle.remove(), 6000);
      return;
    }
  } catch { /* on bascule sur le repli */ }

  // Repli : on ouvre l'app avec la liste dans l'adresse. Une navigation passe
  // là où une requête en arrière-plan est bloquée.
  dire('Ouverture de Ciné IDF…');
  window.open(`${APP}/#wl=${encodeURIComponent(JSON.stringify({ films, pseudo }))}`, '_blank');
  setTimeout(() => bulle.remove(), 4000);
})();
