# Ciné IDF — installation

Toutes les séances de cinéma d'Île-de-France, sur ton PC. Aucun compte à créer, rien à
payer, rien n'est envoyé nulle part.

## Sur Windows : un double-clic

1. **Décompresse** `cine-idf.zip` où tu veux (Bureau, Documents…).
2. Dans le dossier `cine-idf`, **double-clique sur `Installer Cine IDF.cmd`**.
   - S'il manque Node.js (le moteur de l'app), il te propose de l'installer : réponds **O**.
     Windows peut demander une autorisation, c'est normal.
   - Il crée le raccourci **Ciné IDF** sur ton Bureau et ouvre l'app.
3. C'est fini. Ensuite, double-clic sur **Ciné IDF** sur le Bureau.

> Si Windows affiche « Windows a protégé votre ordinateur » au premier double-clic :
> clique **Informations complémentaires** puis **Exécuter quand même**. Le fichier
> est un simple script lisible avec le Bloc-notes.

**Le premier lancement prend environ 15 minutes** : l'app récupère toute seule les
séances de la semaine. Tu peux t'en servir pendant ce temps, elle se remplit au fur et
à mesure. Ensuite, elle se tient à jour seule, en arrière-plan.

## À régler une fois, dans le panneau de gauche

- **Ta watchlist Letterboxd** : tape ton pseudo et clique **Relier**. Elle sera relue
  toute seule à chaque ouverture, et une bande « Ta watchlist cette semaine » te montre
  les films à voir qui passent. Ta watchlist doit être publique sur Letterboxd (c'est
  le réglage par défaut).
- **Pas de carte UGC Illimité ?** Décoche « Uniquement la carte UGC Illimité » pour voir
  les 362 cinémas d'Île-de-France (le premier remplissage prend alors ~45 min).
- **Autour de moi** : « Ma position » ou une adresse, pour trier par distance.

## Sur Mac : un double-clic aussi

1. **Décompresse** `cine-idf.zip` (double-clic dessus) et range le dossier `cine-idf`
   où tu veux, par exemple dans Documents.
2. Dans le dossier, **ouvre `Installer Cine IDF.command`**.
   - Au premier essai, macOS bloque le fichier (« développeur non identifié ») :
     va dans **Réglages Système › Confidentialité et sécurité**, tout en bas clique
     **Ouvrir quand même**, puis confirme. Sur les macOS plus anciens : clic droit sur
     le fichier › **Ouvrir** › **Ouvrir**. C'est à faire une seule fois.
   - S'il manque Node.js : avec Homebrew, il propose de l'installer (réponds **o**) ;
     sinon il ouvre la page de téléchargement : prends la version LTS pour macOS,
     installe-la, puis appuie sur Entrée dans la fenêtre.
   - Il crée l'app **Ciné IDF** sur ton Bureau, avec son icône, et l'ouvre.
3. Ensuite, double-clic sur **Ciné IDF** sur le Bureau.

L'app s'ouvre dans sa propre fenêtre si tu as Chrome, Edge ou Brave, sinon dans ton
navigateur habituel (Safari marche aussi).

> Ne déplace plus le dossier `cine-idf` après l'installation : l'app du Bureau va le
> chercher à cet endroit. Si tu le déplaces, relance simplement l'installeur.

## Sur Linux

Installe Node.js 20 ou plus, puis lance `./start.sh` dans le dossier (ou
`node src/server.js` et ouvre <http://localhost:4173>).

## Bon à savoir

- L'app ne tourne que sur ton PC et n'écoute que lui. Elle s'arrête toute seule
  30 minutes après la fermeture de sa fenêtre.
- Le dossier `data/` est créé au premier lancement : ce sont tes données (séances,
  favoris, watchlist). Ne le partage pas.
- Si quelque chose bloque, la barre en haut de l'app dit ce qui se passe, avec un
  bouton **Réessayer**.
- `README.md` détaille tout le reste.

**Usage personnel.** Les séances viennent d'AlloCiné : chacun récupère les siennes sur
son PC, ne redistribue pas le contenu de `data/`.
