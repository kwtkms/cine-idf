# 🎬 Ciné IDF

Les séances de cinéma d'Île-de-France, consultables en local dans le navigateur.
Aucune dépendance npm, aucune clé d'API.

**Par défaut, l'app se limite aux 103 salles où la carte UGC Illimité est acceptée**
(voir plus bas). Le catalogue complet compte 362 salles et reste accessible en une case
à cocher.

## Démarrer

Double-clic sur **Ciné IDF** sur le bureau. C'est tout.

Le raccourci démarre le serveur local en tâche de fond et ouvre l'app dans sa propre
fenêtre (sans barre d'adresse ni onglets), avec sa propre icône dans la barre des tâches.

**Elle se met à jour toute seule** : à l'ouverture, puis **tant que la fenêtre reste
ouverte**, dès qu'une journée dépasse sa durée de fraîcheur (voir plus bas), la
récupération repart en arrière-plan — jamais plus d'une fois par quart d'heure. La barre
d'état affiche la progression et les séances se complètent au fil de l'eau, **sans
rechargement de page ni perte de tes filtres**. Aucune tâche planifiée, rien qui tourne
quand l'app est fermée.

Le bouton **Mettre à jour** en haut à droite force une récupération à la demande.

### La barre d'état

Une bande sous l'en-tête dit toujours où en est l'app :

| Couleur | Quand | Ce qu'elle affiche |
|---|---|---|
| Bleu | récupération en cours | `Mise à jour · jour 2/5 · 168/362 salles · 4 812 séances` + barre de progression |
| Vert | récupération terminée | `Tout est à jour — 21 721 séances · 362 cinémas · 5 jours`, disparaît après 8 s |
| Rouge | échec | la cause en clair, + **Réessayer** et **Détails** (les 25 dernières lignes du journal) |

La bannière rouge **survit à un rechargement de page** (résultat conservé dans
`data/last-refresh.json`) : une mise à jour qui a échoué pendant la nuit est encore
signalée le lendemain matin. Et dans tous les cas, **les séances déjà récupérées
restent consultables** — un échec ne vide jamais l'app.

**Quand tu fermes la fenêtre, le serveur s'arrête tout seul** au bout de 30 minutes
(`IDLE_MIN` pour changer le délai) : rien ne traîne en mémoire jusqu'au redémarrage.
Sa présence est détectée par une connexion maintenue ouverte, pas par une minuterie
JavaScript — le navigateur gèle les minuteries d'une fenêtre en arrière-plan, la
connexion, elle, tient. Une récupération en cours empêche l'arrêt.

### Recréer le raccourci

```powershell
$root = "$PWD"
$nom = "Cin" + [char]0xE9 + " IDF.lnk"   # accent posé par code, pour éviter les soucis d'encodage
$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) $nom))
$s.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\start.ps1`""
$s.WorkingDirectory = $root; $s.IconLocation = "$root\assets\cine-idf.ico"; $s.WindowStyle = 7
$s.Save()
```

Le dossier `cine-idf` peut être déplacé n'importe où — il suffit de recréer le raccourci
depuis son nouvel emplacement.

## Ce que tu peux faire

- **Par film** : chaque film avec tous les cinémas qui le passent et les horaires.
- **Par cinéma** : chaque salle avec sa programmation du jour.
- **Autour de moi** : géolocalisation ou saisie d'une adresse, distance affichée sur
  chaque salle, filtre par rayon (1 à 20 km) et tri par proximité.
- **Recherche tolérante aux fautes** sur le titre, le réalisateur, les acteurs, le
  cinéma, la ville et le genre — « chunking express » trouve *Chungking Express*,
  « patheon » trouve le Cinéma du Panthéon. Sans résultat à la date affichée, elle
  cherche sur les autres jours et propose d'y aller.
- Filtres : département, ville, cinéma, VF/VOST, créneau horaire, genre,
  avant-premières, séances passées.
- **Panier de séances** : un clic sur un horaire le met de côté (la pastille passe
  au vert). Le bouton 🎟 en bas à droite ouvre la liste, groupée par jour et triée
  par heure, avec le lien de réservation. Rien ne se perd en scrollant.
- ★ Mets tes cinémas en favoris, puis coche « Uniquement mes cinémas ».
- **Watchlist Letterboxd** : importe ton `watchlist.csv` et les films qui y figurent
  sont marqués d'un badge vert, avec un filtre « Uniquement ma watchlist ».
- La réservation (UGC, Pathé, billetterie de la salle) se lance depuis le panier.
- Tri : le plus de séances, le plus proche, alphabétique, note spectateurs,
  note presse, sorties récentes, **prochaine séance**.
- Sur la journée du jour, les séances qui commencent dans moins de 2 h sont
  surlignées, et la prochaine de chaque salle est annotée « dans 25 min ».

Filtres et favoris sont mémorisés dans le navigateur.

## Sur téléphone

L'interface est déjà pensée pour le tactile (filtres repliables, cibles de 42 à 48 px,
pas de défilement horizontal). Il suffit d'ouvrir le serveur au réseau local :

```bash
npm run mobile
```

Il affiche alors l'adresse à saisir sur le téléphone, du genre `http://192.168.1.20:4173` (la tienne sera différente).
Ensuite, **Ajouter à l'écran d'accueil** depuis le navigateur : tu obtiens une icône
Ciné IDF sur ton téléphone, qui ouvre l'app en plein écran.

Le transfert est léger : **387 Ko compressés** pour les 5 journées et les 362 cinémas.

Le garde-fou reste actif — le serveur n'accepte que les requêtes venant de sa propre
adresse, un site web tiers ouvert sur le téléphone ne peut pas l'appeler.

**Ce que ça ne fait pas** : ça marche uniquement **chez toi, PC allumé, même réseau**.
Pas de consultation dans le métro. Pour un vrai fonctionnement hors ligne il faudrait
un *service worker*, or les navigateurs les refusent hors HTTPS — et une adresse
`192.168.x.x` en HTTP n'est pas un contexte sécurisé. Héberger l'app en ligne
résoudrait ça, mais reviendrait à redistribuer les données d'AlloCiné, ce que leurs
conditions n'autorisent pas.

## Carte UGC Illimité

La carte n'est pas valable que dans les UGC : UGC publie une liste officielle de
**cinémas partenaires** qui l'acceptent — les mk2, et beaucoup d'indépendants
(Christine Cinéma Club, Filmothèque du Quartier Latin, les Chaplin, Abel Gance,
Le Grand Rex…).

Source unique et faisant foi : <https://www.ugc.fr/cinemas-acceptant-ui.html>,
rendue côté serveur, donc lisible directement. `node src/ugc.js` la récupère, la
rapproche du catalogue AlloCiné et marque les salles concernées. C'est relancé
automatiquement à chaque rafraîchissement de la liste des cinémas, car le réseau de
partenaires évolue.

Relevé du 03/08/2026 : **103 salles en Île-de-France**, dont 58 à Paris.
Les 103 ont été rapprochées, aucune perdue.

Le rapprochement se fait sur le nom, le code postal **et l'adresse** — c'est
l'adresse qui départage les homonymes, comme les deux « Ariel » de Rueil-Malmaison
(Centre-ville avenue Paul-Doumer / Hauts de Rueil avenue de Fouilleuse).

La case **« Uniquement les cinémas acceptés »** pilote deux choses à la fois :
ce qui s'affiche, et **ce qui est récupéré**. Interroger 103 salles au lieu de 362
divise le temps de mise à jour par 3,5.

| Périmètre | Salles | Une journée | 5 jours à froid |
|---|---|---|---|
| UGC Illimité *(défaut)* | 103 | ~2 min 45 | **~14 min** |
| Tout l'Île-de-France | 362 | ~9 min | ~47 min |

En ligne de commande : `node src/scrape.js --all` pour tout reprendre,
`--ugc-only` pour forcer le périmètre réduit. Le réglage de l'interface est
mémorisé dans `data/scope.json`.

## Notes Letterboxd

Les fiches films affichent la note **Letterboxd** quand elle est connue (en bleu,
suffixe `LB`), et retombent sur celle d'**AlloCiné** sinon (en jaune, suffixe `AC`).
Les deux sont sur 5, donc directement comparables. L'infobulle donne la source et le
nombre de votes. Le tri « Mieux notés » utilise la note affichée.

Letterboxd n'a pas d'API ouverte et sa recherche est rendue côté client — vérifié,
zéro résultat exploitable dans le HTML. En revanche la **fiche d'un film** est rendue
côté serveur et contient la note dans un bloc JSON-LD. `src/letterboxd.js` reconstruit
donc l'adresse à partir du titre :

1. `titre-original-année` — l'année d'abord, car Letterboxd s'en sert pour départager
   les homonymes : sans elle on tombe sur le *Michael* de 2011 au lieu de celui de 2026 ;
2. `titre-original` ;
3. les deux mêmes avec le titre français.

Chaque candidat est validé sur l'année trouvée dans la page avant d'être accepté.

**Taux de correspondance mesuré : 201 films sur 322, soit 62 %.** Les échecs sont ceux dont le
titre Letterboxd ne ressemble ni au titre français ni au titre original (*Salò o le
120 giornate di Sodoma* → `salo-or-the-120-days-of-sodom`). Sans identifiant commun
entre les deux sites, c'est le plafond de la méthode ; le repli AlloCiné couvre le reste.

Les notes sont **mises en cache définitivement** dans `data/letterboxd.json` : un film
déjà résolu n'est jamais redemandé, et les films introuvables ne sont retentés qu'au
bout de 30 jours. Seule la nouveauté coûte quelque chose, et la mise à jour en
récupère au plus 120 par passage pour ne pas s'éterniser.

## Ma liste à voir

Elle se remplit de deux façons, qui se cumulent.

**1. Dans l'app, en un clic.** Chaque film porte un bouton **+** ; il passe en ✓ vert
et rejoint ta liste. C'est ce qui rend l'app autonome au quotidien : tu vois un film
qui t'intéresse, tu le marques, tu le retrouves les jours suivants.

**2. Marque-page « Envoyer vers Ciné IDF ».**

Installe-le une fois : ouvre `http://localhost:4173/marque-page.html` et glisse le
bouton dans ta barre de favoris.

Ensuite, depuis un ordinateur : ouvre ta page watchlist Letterboxd et clique le favori.
Il charge toute la liste et l'envoie à l'app. Ça récupère aussi ce que tu as ajouté
depuis ton téléphone.

**Pourquoi ça marche alors que le scraping échoue ?** Parce que ça s'exécute dans *ton*
navigateur, sur une page où tu es connecté et où le challenge Cloudflare est déjà résolu.
Vu de l'extérieur la watchlist est inaccessible ; vue de ta page, elle est dans le DOM.

Deux détails qui expliquent mes échecs précédents : Letterboxd a renommé son attribut
`data-film-slug` en `data-item-slug`, et le titre + l'année sont dans le texte
alternatif de l'affiche (`Poster for Whiplash (2014)`).

Le favori tente d'abord un envoi direct. Si le navigateur le bloque — un site public
appelant une adresse locale, c'est restreint — il affiche un bouton de secours qui
ouvre Ciné IDF avec la liste. Les deux chemins sont testés.

**Ciné IDF doit tourner** au moment du clic.

**3. Export CSV — le repli.**

1. Letterboxd → **Settings** → **Import & Export** → **Export your data**
2. Laisse le zip dans **Téléchargements**. C'est tout.

À la prochaine ouverture, l'app repère l'export, en extrait `watchlist.csv` et
l'importe seule. Pas de dézippage, pas de fichier à choisir. Un bandeau confirme
(« Watchlist reprise depuis letterboxd-….zip — 4 films ») avec un bouton
**Supprimer le fichier**, pour que les exports ne s'accumulent pas.

Un export déjà repris n'est jamais réimporté : la comparaison se fait sur la date du
fichier. Le bouton **Réimporter** reste là si tu préfères choisir le fichier à la main.

La lecture du zip se fait sans dépendance — Node sait déjà décompresser, il ne manquait
que la lecture de l'index de l'archive. Passé 14 jours, l'app te rappelle discrètement
que l'import date. Les films venus de Letterboxd n'ont
pas de bouton de retrait dans l'app : on les enlève sur Letterboxd puis on réimporte,
pour que les deux listes ne divergent pas en silence.

**Pourquoi pas une synchro automatique ?** Vérifié : Letterboxd n'a pas d'API ouverte,
pas de flux RSS pour la watchlist (le RSS ne donne que les films *vus*), et toutes
leurs grilles de posters — watchlist comprise — sont rendues par JavaScript, donc
absentes du HTML. Il faudrait piloter un navigateur sans interface (~300 Mo de
dépendances) pour une app qui n'en a aucune. Le bouton **+** couvre le besoin
quotidien, l'import couvre la reprise du stock.

Le rapprochement des titres se fait sur le **titre original** et le titre français,
avec un an de tolérance sur l'année (production côté Letterboxd, sortie française côté
AlloCiné) : « A Clockwork Orange » retrouve « Orange mécanique ». Un titre très remanié
peut passer à travers — limite inhérente à l'absence d'identifiant commun.

## Commandes (si besoin, en dehors de l'app)

| Commande | Effet |
|---|---|
| `npm run refresh` | 5 jours à partir d'aujourd'hui, reprend ce qui manque |
| `node src/scrape.js --days=7` | sur 7 jours (max 21) |
| `node src/scrape.js --force` | ignore le cache et tout refaire |
| `node src/scrape.js --theaters-only` | met à jour la seule liste des salles |
| `npm start` | serveur seul (port 4173, ou `PORT=8080 npm start`) |
| `npm run verify` | compare séance par séance l'app et AlloCiné, aujourd'hui et demain (~10 min ; `-- --days=5` pour tout) |
| `npm run calibrate` | remesure le débit toléré par AlloCiné (~6 min) |
| `npm run geocode` | (re)calcule les coordonnées des salles (`--force` pour tout refaire) |
| `node src/make-icon.js` | régénère l'icône de l'app |

Un seul scrape peut tourner à la fois (verrou `data/.refresh.lock`) : lancer une
commande pendant que l'app se met à jour ne risque pas de corrompre les données.

## Source des données

Les pages publiques d'AlloCiné et son endpoint JSON `/_/showtimes/...` — exactement
les mêmes requêtes que celles faites par le site quand on le consulte.

Les coordonnées des salles viennent de la **Base Adresse Nationale**
(`api-adresse.data.gouv.fr`, service public, sans clé) : les 362 adresses sont
géocodées en une requête. 354 le sont à l'adresse exacte, 8 au centre de la commune
ou de l'arrondissement (adresses AlloCiné trop approximatives, type « à l'intérieur
du Grand Palais »). Le serveur relaie aussi la recherche d'adresse, ce qui permet de
choisir un point de départ sans autoriser la géolocalisation.

AlloCiné est derrière Cloudflare et coupe au-delà d'un certain débit. Plutôt que de
deviner cette limite, `npm run calibrate` la **mesure** : il monte par paliers jusqu'au
premier 429 et écrit `data/rate.json`, que le scraper relit.

Mesure du 31/07/2026 : 1,6 req/s tenu sur 75 s, blocage à 2 req/s. **Mais AlloCiné
tolère bien plus en rafale qu'en continu** : à 1,12 req/s, une reconstruction complète
s'est fait bloquer après 6 minutes d'affilée. Le débit reste stable une fois retombé
vers 0,6 req/s — d'où la marge volontairement large (40 % du palier tenu), soit
**0,64 req/s**. Le scraper mémorise en plus toute réduction qu'il a dû subir, pour
démarrer au bon rythme la fois suivante.

Le reste est géré tout seul :

- **rafraîchissement sur place** : une journée déjà complète n'est jamais vidée pour
  être reconstruite — les séances sont remplacées salle par salle, donc l'app affiche
  une programmation complète pendant toute l'opération. C'est ce qui fait qu'il n'y a
  aucun temps de chargement perçu ;
- **récupération incrémentale** : le fichier du jour est réécrit toutes les 25 salles,
  donc une coupure ne fait jamais perdre le travail déjà fait ;
- relancer `npm run refresh` **reprend exactement où ça s'était arrêté** ;
- **fraîcheur par paliers** (`src/freshness.js`, partagé par le serveur et la
  récupération) : aujourd'hui est retéléchargé au bout de 4 h, demain 8 h, les jours
  suivants 24 h — la mise à jour ne refait donc pas tout. Sauf pour un jour encore
  **creux** (moins de 40 % d'une journée normale : programme pas encore publié,
  typiquement le mercredi vu depuis le lundi) : il est revérifié toutes les 2 h, pour
  que la nouvelle semaine apparaisse dès sa publication. L'app le signale par un
  bandeau et un point sur la date ;
- **ordre de priorité** : tes cinémas favoris ★ d'abord (l'app envoie la liste au
  serveur), puis les salles les plus fournies — tes salles sont à jour en quelques
  secondes, l'essentiel de la programmation en deux ou trois minutes ;
- ralentissement adaptatif et reprise automatique si AlloCiné bloque quand même ;
- une salle sans rien un jour donné n'est sautée que pour les jours **suivants**, et
  seulement pendant la même mise à jour (moins d'une heure) : AlloCiné ne distingue
  pas « fermée » de « programme pas encore publié ». L'ancienne règle, qui la croyait
  deux jours et pour toutes les dates, faisait sauter jusqu'à 34 salles ouvertes (corrigé
  le 14/09/2026) ;
- **réponses tronquées** : AlloCiné renvoie parfois une liste incomplète (vu le
  14/09/2026 : 60 séances sur 150 aux Halles, complète vingt minutes plus tard). Si une
  salle revient avec moins de la moitié de ses séances précédentes, elle est relue une
  fois et la réponse la plus fournie est gardée ; deux lectures faibles de suite valent
  un vrai changement de programme ;
- **pagination** : AlloCiné a déjà annoncé 1 page au lieu de 3. Tant que la page
  précédente est pleine, la suivante est demandée quand même ;
- **salles muettes** : une salle interrogée chaque jour mais sans aucun horaire publié
  en ligne (ex. Cinéma 4 Delta en septembre 2026) est listée sous la case UGC Illimité,
  avec l'invitation à l'appeler ;
- après chaque mise à jour, **toutes** les journées déjà ouvertes sont rechargées (avant,
  seule la journée affichée l'était et les autres pouvaient rester à l'ancienne version).

**Vérification** : `npm run verify` retélécharge chaque salle en direct et liste les
écarts. Le 14/09/2026, après corrections : 0 séance manquante et 0 en trop sur aujourd'hui
et demain ; les seuls écarts des jours suivants étaient des programmes publiés pendant
la vérification elle-même.

**Durées mesurées** (pas estimées) :

| Situation | Durée | Ce que tu vois |
|---|---|---|
| Depuis zéro, 5 journées | **~47 min** | app utilisable après 45 s, remplissage progressif |
| Une journée seule | ~9 min | rien, la programmation reste affichée |
| Ouverture, données fraîches | instantané | rien |

La reconstruction complète du 31/07/2026 a pris 47 min 22 s, dont 7 min de pauses
imposées par deux blocages Cloudflare. C'est le pire cas : app laissée de côté assez
longtemps pour que toutes les dates stockées soient périmées. Ça ne s'aggrave pas avec
la durée d'absence — 1 mois ou 1 an, c'est la même reconstruction.

Si la récupération s'interrompt (`Données partielles enregistrées`), les données déjà
là sont utilisables immédiatement — il suffit de relancer la commande plus tard pour
compléter.

## Fichiers

```
start.ps1         lanceur : serveur en tâche de fond + fenêtre d'app
src/allocine.js   accès réseau : cookies, en-têtes, régulation du débit, parsing
src/scrape.js     récupération + normalisation + écriture de data/
src/server.js     serveur local (127.0.0.1 uniquement) + mise à jour auto au démarrage
src/calibrate.js  mesure le débit toléré par AlloCiné
src/geocode.js    coordonnées des salles via la Base Adresse Nationale
src/make-icon.js  génère assets/cine-idf.ico (sans dépendance)
public/           interface (HTML/CSS/JS, sans framework)
data/             cinémas et séances par jour (généré, non versionné)
```

## Note

Usage strictement personnel. Les données appartiennent à AlloCiné et aux exploitants ;
ne pas redistribuer les fichiers de `data/`.
