@echo off
rem Double-clic : compare l'app a AlloCine seance par seance (aujourd'hui et demain, ~10 min).
rem Passe par node directement : PowerShell bloque souvent "npm" (scripts desactives).
chcp 65001 >nul
cd /d "%~dp0"
title Verification Cine IDF
node src\verify.js %*
echo.
pause
