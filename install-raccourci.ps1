# Cree le raccourci « Ciné IDF » sur le Bureau, qui lance start.ps1 depuis ce dossier.
# Appele par « Installer Cine IDF.cmd » ; -Dossier permet de le poser ailleurs (tests).
param([string]$Dossier = [Environment]::GetFolderPath('Desktop'))

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$nom = 'Cin' + [char]0xE9 + ' IDF.lnk'   # accent pose par code : pas de souci d'encodage
$lien = Join-Path $Dossier $nom

$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lien)
$s.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\start.ps1`""
$s.WorkingDirectory = $root
$s.IconLocation = "$root\assets\cine-idf.ico"
$s.WindowStyle = 7
$s.Description = 'Toutes les seances de cinema d''Ile-de-France'
$s.Save()
Write-Output $lien
