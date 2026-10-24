@echo off
rem Installation de Cine IDF en un double-clic :
rem   1. verifie Node.js (et propose de l'installer avec winget s'il manque)
rem   2. cree le raccourci "Cine IDF" sur le Bureau
rem   3. lance l'app, qui recupere les seances toute seule au premier demarrage
rem Rien n'est envoye nulle part ; l'app tourne uniquement sur ce PC.
setlocal
cd /d "%~dp0"
title Installation de Cine IDF
echo.
echo   Installation de Cine IDF
echo   ========================
echo.

rem ------------------------------------------------------------ 1. Node.js
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if defined NODE goto :version

echo   Node.js n'est pas installe : l'app en a besoin pour fonctionner.
where winget >nul 2>nul
if errorlevel 1 goto :sansnode
choice /c ON /n /m "   L'installer maintenant ? [O = oui / N = non] "
if errorlevel 2 goto :sansnode
echo.
winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE goto :sansnode

:version
"%NODE%" -e "process.exit(+process.versions.node.split('.')[0] >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo   Ta version de Node.js est trop ancienne : il faut la 20 ou plus.
  echo   Installe la version LTS depuis https://nodejs.org puis relance ce fichier.
  goto :fin
)
echo   Node.js : OK

rem ------------------------------------------------------------ 2. Raccourci
rem (CINE_IDF_SHORTCUT_DIR : pour tester sans toucher au vrai Bureau)
set "OU="
if defined CINE_IDF_SHORTCUT_DIR set "OU=-Dossier "%CINE_IDF_SHORTCUT_DIR%""
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-raccourci.ps1" %OU% >nul
if errorlevel 1 (
  echo   Le raccourci n'a pas pu etre cree. Tu peux lancer l'app avec start.ps1.
) else (
  echo   Raccourci "Cine IDF" cree sur le Bureau : OK
)

rem ------------------------------------------------------------ 3. Lancement
echo.
echo   C'est installe. L'app s'ouvre.
echo.
echo   - Au premier lancement, elle recupere les seances : compte environ 15 min.
echo     Tu peux t'en servir pendant ce temps, elle se remplit au fur et a mesure.
echo   - Dans le panneau de gauche, mets ton pseudo Letterboxd : ta watchlist
echo     sera relue toute seule a chaque ouverture.
echo   - Pas de carte UGC Illimite ? Decoche "Uniquement la carte UGC Illimite"
echo     pour voir les 362 cinemas d'Ile-de-France.
echo.
echo   Ensuite, il suffit de double-cliquer sur "Cine IDF" sur le Bureau.
if not "%CINE_IDF_NO_LAUNCH%"=="1" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start.ps1"
goto :fin

:sansnode
echo.
echo   Installe Node.js (version LTS) depuis https://nodejs.org,
echo   puis double-clique de nouveau sur ce fichier.

:fin
echo.
pause
