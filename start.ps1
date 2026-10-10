# Lanceur de l'app Ciné IDF.
# Demarre le serveur local en tache de fond s'il ne tourne pas deja, attend qu'il
# reponde, puis ouvre l'app dans sa propre fenetre (sans barre d'adresse).

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 4173
$url  = "http://localhost:$port"

function Test-Port {
    $client = New-Object Net.Sockets.TcpClient
    try { $client.Connect('127.0.0.1', $port); $client.Close(); return $true }
    catch { return $false }
}

# --- serveur ---------------------------------------------------------------
if (-not (Test-Port)) {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { $node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
    if (-not (Test-Path $node)) {
        Add-Type -AssemblyName PresentationFramework
        [Windows.MessageBox]::Show("Node.js est introuvable. Installe-le depuis nodejs.org puis relance Ciné IDF.", 'Ciné IDF') | Out-Null
        exit 1
    }
    Start-Process -FilePath $node -ArgumentList 'src\server.js' -WorkingDirectory $root -WindowStyle Hidden

    for ($i = 0; $i -lt 60; $i++) {
        if (Test-Port) { break }
        Start-Sleep -Milliseconds 250
    }
}

if (-not (Test-Port)) {
    Add-Type -AssemblyName PresentationFramework
    [Windows.MessageBox]::Show("Le serveur Ciné IDF n'a pas demarre.", 'Ciné IDF') | Out-Null
    exit 1
}

# --- fenetre d'application -------------------------------------------------
# Chrome ou Edge en mode --app : fenetre autonome, sans onglets ni barre d'adresse.
$browsers = @(
    (Join-Path $env:ProgramFiles        'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA        'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:ProgramFiles        'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
)
$browser = $browsers | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($browser) {
    # Profil dedie : l'app garde sa propre fenetre, sa propre icone dans la barre
    # des taches, et ne se melange pas aux onglets de navigation.
    $profile = Join-Path $env:LOCALAPPDATA 'CineIDF\browser-profile'
    Start-Process -FilePath $browser -ArgumentList @(
        "--app=$url",
        "--user-data-dir=`"$profile`"",
        '--window-size=1360,900',
        '--no-first-run',
        '--no-default-browser-check'
    )
} else {
    Start-Process $url
}
