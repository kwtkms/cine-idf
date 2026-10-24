#!/bin/bash
# Installation de Cine IDF sur Mac, en un double-clic :
#   1. verifie Node.js (propose de l'installer avec Homebrew, ou ouvre nodejs.org)
#   2. cree l'app « Cine IDF » sur le Bureau
#   3. lance l'app, qui recupere les seances toute seule au premier demarrage
# Rien n'est envoye nulle part ; l'app tourne uniquement sur ce Mac.

cd "$(dirname "$0")" || exit 1
DOSSIER="$(pwd)"
fin() { echo; read -r -p "  Appuie sur Entree pour fermer cette fenetre. " _; exit "${1:-0}"; }

echo
echo "  Installation de Cine IDF"
echo "  ========================"
echo

# ------------------------------------------------------------ 1. Node.js
trouver_node() {
  NODE="$(command -v node 2>/dev/null)"
  for c in /usr/local/bin/node /opt/homebrew/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -z "$NODE" ] && [ -x "$c" ]; then NODE="$c"; fi
  done
}
trouver_node

if [ -z "$NODE" ]; then
  echo "  Node.js n'est pas installe : l'app en a besoin pour fonctionner."
  BREW="$(command -v brew 2>/dev/null || ls /opt/homebrew/bin/brew /usr/local/bin/brew 2>/dev/null | head -1)"
  if [ -n "$BREW" ]; then
    read -r -p "  L'installer maintenant avec Homebrew ? [o/n] " r
    if [ "$r" = "o" ] || [ "$r" = "O" ]; then "$BREW" install node; fi
  else
    echo "  La page de telechargement va s'ouvrir : prends la version LTS pour macOS,"
    echo "  installe-la (installation par defaut), puis reviens ici."
    open "https://nodejs.org/fr/download" 2>/dev/null
    read -r -p "  Appuie sur Entree une fois Node.js installe... " _
  fi
  trouver_node
fi

if [ -z "$NODE" ]; then
  echo
  echo "  Node.js est toujours introuvable. Installe la version LTS depuis"
  echo "  https://nodejs.org puis double-clique de nouveau sur ce fichier."
  fin 1
fi

if ! "$NODE" -e "process.exit(+process.versions.node.split('.')[0] >= 20 ? 0 : 1)"; then
  echo "  Ta version de Node.js est trop ancienne : il faut la 20 ou plus."
  echo "  Installe la version LTS depuis https://nodejs.org puis relance ce fichier."
  fin 1
fi
echo "  Node.js : OK"

# ------------------------------------------------------------ 2. App sur le Bureau
chmod +x "$DOSSIER/start.sh" 2>/dev/null
BUREAU="${CINE_IDF_SHORTCUT_DIR:-$HOME/Desktop}"
APP="$BUREAU/Ciné IDF.app"
rm -rf "$APP"
# Petite app AppleScript qui lance start.sh, sans fenetre de Terminal.
CHEMIN="${DOSSIER//\\/\\\\}"; CHEMIN="${CHEMIN//\"/\\\"}"
if osacompile -o "$APP" -e "do shell script quoted form of \"$CHEMIN/start.sh\"" 2>/dev/null; then
  # Icone de l'app, depuis public/icon.png (outils fournis avec macOS).
  ICONES="$(mktemp -d)/cine.iconset"
  mkdir -p "$ICONES"
  for t in 16 32 64 128 256; do
    sips -z "$t" "$t" "$DOSSIER/public/icon.png" --out "$ICONES/icon_${t}x${t}.png" >/dev/null 2>&1
  done
  if iconutil -c icns "$ICONES" -o "$APP/Contents/Resources/applet.icns" >/dev/null 2>&1; then
    touch "$APP"
  fi
  echo "  App \"Cine IDF\" creee sur le Bureau : OK"
else
  echo "  L'app du Bureau n'a pas pu etre creee : lance plutot start.sh dans ce dossier."
fi

# ------------------------------------------------------------ 3. Lancement
echo
echo "  C'est installe. L'app s'ouvre."
echo
echo "  - Au premier lancement, elle recupere les seances : compte environ 15 min."
echo "    Tu peux t'en servir pendant ce temps, elle se remplit au fur et a mesure."
echo "  - Dans le panneau de gauche, mets ton pseudo Letterboxd : ta watchlist"
echo "    sera relue toute seule a chaque ouverture."
echo "  - Pas de carte UGC Illimite ? Decoche \"Uniquement la carte UGC Illimite\""
echo "    pour voir les 362 cinemas d'Ile-de-France."
echo
echo "  Ensuite, il suffit d'ouvrir \"Cine IDF\" sur le Bureau."
if [ "$CINE_IDF_NO_LAUNCH" != "1" ]; then "$DOSSIER/start.sh"; fi
fin 0
