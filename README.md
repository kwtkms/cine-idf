# 🎬 Ciné IDF

Les séances de cinéma d'Île-de-France, consultables en local dans le navigateur.
Aucune dépendance npm, aucune clé d'API.

**Par défaut, l'app se limite aux 103 salles où la carte UGC Illimité est acceptée**
(voir plus bas). Le catalogue complet compte 362 salles et reste accessible en une case
à cocher.

## Démarrer

Double-clic sur **Ciné IDF** sur le bureau. C'est tout.

**Sur un autre PC** (un pote) : décompresser le zip et double-cliquer sur
`Installer Cine IDF.cmd`. Il vérifie Node.js (et propose de l'installer avec winget),
crée le raccourci du Bureau et lance l'app, qui fait sa première récupération seule.
Aucune commande à taper. Testé le 16/10/2026 sur une copie neuve : liste des 362 salles,
géolocalisation et carte UGC en moins d'une minute, puis les séances au fil de l'eau.
Sur **Mac**, même principe avec `Installer Cine IDF.command` : il crée une app « Ciné IDF »
sur le Bureau (AppleScript + `start.sh`, avec l'icône). Le zip se fabrique avec
**`npm run zip`** (`src/make-zip.js`), qui sort deux zips — `cine-idf-windows.zip` et
`cine-idf-mac.zip`, chacun sans les fichiers de l'autre système. Il exclut `data/` et garde la permission
« exécutable » des scripts Mac, que l'Explorateur Windows perdrait.
Détails pour la personne qui reçoit : `INSTALLATION.md`.

Le raccourci démarre le serveur local en tâche de fond et ouvre l'app dans sa propre
fenêtre (sans barre d'adresse ni onglets), avec sa propre icône dans la barre des tâches.

**Elle se met à jour toute seule** : à l'ouverture, puis **tant que la fenêtre reste
ouverte**, dès qu'une journée dépasse sa durée de fraîcheur (voir plus bas), la
récupération repart en arrière-plan — jamais plus d'une fois par quart d'heure. La barre
d'état affiche la progression et les séances se complètent au fil de l'eau, **sans
rechargement de page ni perte de tes filtres**. Aucune tâche planifiée, rien qui tourne
quand l'app est fermée.

Le bouton **Mettre à jour** en haut à droite relit **tous** les jours, même ceux encore
frais (environ 15 min pour 5 jours), sans rien vider pendant l'opération. Les relances
automatiques, elles, ne relisent que ce qui est périmé.

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

## Apparence

Thème « salle obscure » (refait le 15/10/2026) : fond prune sombre, texte couleur d'écran, un seul
accent ambré pour ce qui est sélectionné et les séances qui approchent. Le thème clair suit
automatiquement le réglage de Windows. Titres, dates et horaires en Bahnschrift (police fournie
avec Windows), le reste en Segoe UI : aucune police à télécharger, l'app reste hors ligne.
Les horaires sont des tickets — « 20:40 ┊ VF » — et chaque cinéma tient sur une ligne.
Ambiance de salle : halo du projecteur en haut de l'écran, grain de pellicule très léger,
bande perforée sous la barre du haut, et chaque fiche teintée par son affiche floutée. En tête
des résultats, l'**affiche du jour** : « Ce soir » / « Vendredi 16 octobre » en grandes lettres,
le nombre de séances et l'heure de la prochaine, sur l'affiche du premier film.

Raccourcis : **/** place le curseur dans la recherche, **Échap** la vide ou ferme le panier.

## Ce que tu peux faire

- **Par film** : un mur d'affiches, sans horaires — titre, note, prochaine séance, nombre de
  cinémas. **Un clic sur un film** ouvre un panneau avec tous ses cinémas et horaires, et les
  autres jours où il passe (un clic change de jour sans fermer). Échap ou clic à côté ferme.
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
nombre de votes, et **un clic sur la note LB ouvre la fiche Letterboxd** du film. Le tri
« Mieux notés » utilise la note affichée.

Letterboxd n'a pas d'API ouverte et sa recherche est rendue côté client — vérifié,
zéro résultat exploitable dans le HTML. En revanche la **fiche d'un film** est rendue
côté serveur et contient la note dans un bloc JSON-LD. Pour trouver l'adresse de la
fiche, `src/letterboxd.js` interroge d'abord **Wikidata**, qui relie l'identifiant
AlloCiné (P1265) à celui de Letterboxd (P6127) — une seule requête pour tous les films,
sans clé. C'est ce qui règle les classiques au titre français (*À bout de souffle* →
`breathless`, *12 hommes en colère* → `12-angry-men`). À défaut, l'adresse est
reconstruite à partir du titre (apostrophes supprimées, comme le fait Letterboxd) :

1. `titre-original-année` — l'année d'abord, car Letterboxd s'en sert pour départager
   les homonymes : sans elle on tombe sur le *Michael* de 2011 au lieu de celui de 2026 ;
2. `titre-original` ;
3. les deux mêmes avec le titre français.

Chaque candidat est validé sur l'année trouvée dans la page avant d'être accepté.

**Taux de correspondance mesuré le 11/10/2026 : 327 films sur 389, soit 84 %** (61 % avant
Wikidata). Les films restants sont surtout des courts-métrages, programmes jeunesse et
documentaires absents de Wikidata ou de Letterboxd ; le repli AlloCiné couvre le reste.

Les notes sont **mises en cache définitivement** dans `data/letterboxd.json` : un film
déjà résolu n'est jamais redemandé, et les films introuvables ne sont retentés qu'au
bout de 30 jours. Seule la nouveauté coûte quelque chose, et la mise à jour en
récupère au plus 120 par passage pour ne pas s'éterniser.

## Ma liste à voir

### Watchlist Letterboxd : synchronisée toute seule

Dans le panneau de gauche, **tape ton pseudo Letterboxd et clique Relier** (coller
l'adresse de ton profil marche aussi). C'est tout : l'app relit ta watchlist **à chaque
ouverture, puis toutes les 30 minutes** tant qu'elle reste ouverte. Tu ajoutes un film
sur ton téléphone, il apparaît dans l'app sans rien faire. Un bouton **Synchroniser**
force une relecture immédiate.

La watchlist doit être **publique** sur Letterboxd (réglage par défaut).

**Comment** (`src/letterboxd-watchlist.js`) : depuis l'automne 2026, la page
`letterboxd.com/<pseudo>/watchlist/` est rendue côté serveur. Chaque film y figure avec
son titre, son année et son identifiant Letterboxd (`data-item-name="May (2002)"
data-item-slug="may"`), 28 par page. L'app relit les pages une à une. Vérifié le
16/10/2026 : 77 films sur 3 pages, exactement le compteur affiché par Letterboxd. Une
lecture incomplète (coupure, Letterboxd qui ne répond pas) n'écrase jamais la liste
existante, et un pseudo mal tapé ne remplace pas celui qui marche.

**Correspondance sûre** : en plus du titre (original ou français, à un an près),
l'app compare l'identifiant Letterboxd du film, connu grâce aux notes et à Wikidata.
« 12 Angry Men » est ainsi reconnu sous « 12 hommes en colère », que le titre seul ratait.

### Ta watchlist cette semaine

En haut de l'app, une bande montre **les films de ta watchlist qui passent sur les
jours récupérés**, avec leurs jours (« Sam, dim »). Un clic ouvre le film au premier
jour où il passe. Elle suit les mêmes critères de lieu que la liste (carte UGC,
départements, favoris…).

### Ajouts dans l'app

Chaque film a un bouton **+** : il passe en ✓ vert et rejoint ta liste, même s'il
n'est pas dans ta watchlist Letterboxd. Et le champ **Ajouter un film** accepte un
film pas encore à l'affiche : il sera signalé dès qu'une séance existe.

### Secours

- **Import d'un fichier** : si ta watchlist est privée, « ou importer un fichier
  d'export » (Letterboxd → Settings → Import & Export → Export your data). Un zip
  laissé dans Téléchargements est aussi repris tout seul à l'ouverture.
- **Marque-page** (`/marque-page.html`) : l'ancienne méthode, d'avant la page
  rendue côté serveur. Il marche toujours, mais il n'est plus nécessaire.

## Commandes (si besoin, en dehors de l'app)

| Commande | Effet |
|---|---|
| `npm run refresh` | 5 jours à partir d'aujourd'hui, reprend ce qui manque |
| `node src/scrape.js --days=7` | sur 7 jours (max 21) |
| `node src/scrape.js --force` | ignore le cache et tout refaire |
| `node src/scrape.js --theaters-only` | met à jour la seule liste des salles |
| `npm start` | serveur seul (port 4173, ou `PORT=8080 npm start`) |
| `node src/letterboxd-watchlist.js <pseudo>` | relit la watchlist Letterboxd publique |
| `npm run zip` | fabrique `cine-idf-windows.zip` et `cine-idf-mac.zip` sur le Bureau (sans tes données) |
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
- **salle perdue par AlloCiné** : AlloCiné retire parfois un cinéma entier de sa liste
  alors que sa billetterie vend toujours les séances (UGC Cyrano le 11/10/2026 : « aucune
  séance » chez AlloCiné, séance de 15h30 confirmée sur ugc.fr). Quand une salle qui avait
  au moins 5 séances à venir tombe d'un coup à zéro, l'app les garde, en pâle avec un
  « ? » et une infobulle qui invite à vérifier sur la billetterie, au lieu de les effacer.
  Même chose pour **un film entier** qui disparaît d'une salle aujourd'hui ou demain
  (La Défense, 11/10/2026 : *Heart of the Beast* absent d'AlloCiné de 14h15 à 15h40).
  Le retrait de séances isolées (complet, annulation) est, lui, appliqué normalement ;
- écritures sûres : journées et notes sont écrites dans un fichier temporaire puis
  renommées, et un cache de notes illisible n'est plus jamais écrasé ;
- après chaque mise à jour, **toutes** les journées déjà ouvertes sont rechargées (avant,
  seule la journée affichée l'était et les autres pouvaient rester à l'ancienne version),
  ainsi que les notes Letterboxd — une fenêtre laissée ouverte n'en voyait plus de nouvelles.

**Vérification** : double-clic sur `Controle des seances Cine IDF.cmd` dans le dossier (ou `node src/verify.js` — `npm run verify` est souvent bloqué par PowerShell, « exécution de scripts désactivée »). Elle retélécharge chaque salle en direct et liste les
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
