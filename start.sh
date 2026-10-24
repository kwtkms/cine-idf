#!/bin/bash
# Lanceur Mac / Linux de Cine IDF (equivalent de start.ps1 sous Windows).
# Demarre le serveur local en tache de fond s'il ne tourne pas deja, attend qu'il
# reponde, puis ouvre l'app dans sa propre fenetre (Chrome, Edge ou Brave en mode
# application), ou a defaut dans le navigateur par defaut.

cd "$(dirname "$0")" || exit 1
PORT=4173
URL="http://localhost:$PORT"

# L'app lancee depuis le Bureau (AppleScript) n'a pas le PATH du Terminal :
# on cherche Node aux emplacements habituels (installeur nodejs.org, Homebrew, nvm).
NODE="$(command -v node 2>/dev/null)"
for c in /usr/local/bin/node /opt/homebrew/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
  if [ -z "$NODE" ] && [ -x "$c" ]; then NODE="$c"; fi
done
if [ -z "$NODE" ]; then
  if command -v osascript >/dev/null 2>&1; then
    osascript -e 'display alert "Ciné IDF" message "Node.js est introuvable. Installe-le depuis nodejs.org puis relance Ciné IDF."' >/dev/null
  else
    echo "Node.js est introuvable : installe-le depuis https://nodejs.org puis relance."
  fi
  exit 1
fi

if ! curl -s -m 1 "$URL/api/ping" >/dev/null 2>&1; then
  nohup "$NODE" src/server.js >/dev/null 2>&1 &
  for _ in $(seq 1 60); do
    curl -s -m 1 "$URL/api/ping" >/dev/null 2>&1 && break
    sleep 0.25
  done
fi

if [ "$(uname)" = "Darwin" ]; then
  # Profil dedie : l'app garde sa propre fenetre et ne se melange pas aux onglets.
  PROFIL="$HOME/Library/Application Support/CineIDF/browser-profile"
  for app in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
    if [ -d "/Applications/$app.app" ] || [ -d "$HOME/Applications/$app.app" ]; then
      open -na "$app" --args --app="$URL" --user-data-dir="$PROFIL" \
        --window-size=1360,900 --no-first-run --no-default-browser-check
      exit 0
    fi
  done
  open "$URL"
else
  (xdg-open "$URL" >/dev/null 2>&1 &)
fi
