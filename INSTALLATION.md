# Ciné IDF — installation

Toutes les séances de cinéma d'Île-de-France, en local sur ta machine.
Aucun compte, aucune clé d'API, aucune dépendance à installer.

## 1. Node.js

Il te faut Node.js 20 ou plus : <https://nodejs.org> (version LTS, installation par défaut).

Pour vérifier, dans un terminal :

```bash
node --version
```

## 2. Poser le dossier

Décompresse `cine-idf` où tu veux — Bureau, Documents, peu importe.

## 3. Première récupération

Dans le dossier, ouvre un terminal et lance :

```bash
npm run refresh
```

Ça interroge AlloCiné pour les 103 salles où la carte UGC Illimité est acceptée,
sur 5 jours. **Compte environ 15 minutes.** C'est long une seule fois : ensuite
l'app se met à jour toute seule et en arrière-plan.

Tu peux déjà ouvrir l'app pendant ce temps, elle se remplit au fur et à mesure.

> Pour avoir les 362 salles d'Île-de-France au lieu des 103 : décoche
> « Uniquement les cinémas acceptés » dans l'app, ou lance `node src/scrape.js --all`.
> Compter ~45 min dans ce cas.

## 4. Lancer

```bash
npm start
```

puis <http://localhost:4173>

## 5. Raccourci sur le bureau (facultatif)

Pour ouvrir l'app en double-clic, dans sa propre fenêtre, avec son icône :

```powershell
$root = "$PWD"
$nom = "Cin" + [char]0xE9 + " IDF.lnk"
$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) $nom))
$s.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\start.ps1`""
$s.WorkingDirectory = $root; $s.IconLocation = "$root\assets\cine-idf.ico"; $s.WindowStyle = 7
$s.Save()
```

À lancer depuis le dossier `cine-idf`, dans PowerShell.

Sur Mac ou Linux, `npm start` suffit — le raccourci est spécifique à Windows.

## Bon à savoir

- Les données arrivent d'AlloCiné, avec un débit volontairement bas pour ne pas
  se faire bloquer. Si une récupération s'interrompt, relancer `npm run refresh`
  reprend exactement où ça s'était arrêté.
- L'app n'écoute que sur ta machine. Rien n'est envoyé nulle part.
- Le dossier `data/` est créé au premier lancement. Il est propre à toi.
- `README.md` détaille le reste : watchlist Letterboxd, notes, mode téléphone,
  périmètre UGC Illimité.

**Usage personnel.** Les données appartiennent à AlloCiné et aux exploitants :
ne redistribue pas le contenu de `data/`.
