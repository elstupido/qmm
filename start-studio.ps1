# QMM Author Studio — local dev launcher (5090). Mirrors start-qmm.ps1.
#   .\start-studio.ps1          start (port 8792, player expected on 8791)
#   .\start-studio.ps1 -Stop    stop
param([switch]$Stop)

$port = 8792
$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue

if ($Stop) {
    if ($existing) { Stop-Process -Id $existing[0].OwningProcess -Force; Write-Host "studio stopped." }
    else { Write-Host "nothing listening on $port." }
    exit 0
}

if ($existing) { Write-Host "studio already up on http://127.0.0.1:$port"; exit 0 }

# Author-chat engine: pick up the MiniMax key from ~/.env (Martin's convention) unless already set.
if (-not $env:MINIMAX_API_KEY) {
    $envFile = Join-Path $env:USERPROFILE '.env'
    if (Test-Path $envFile) {
        $line = Select-String -Path $envFile -Pattern '^MINIMAX_API_KEY=' | Select-Object -First 1
        if ($line) { $env:MINIMAX_API_KEY = $line.Line.Split('=', 2)[1].Trim('"').Trim("'") }
    }
}

# Dev tokens: fine locally (CFA + real tokens gate prod). Set real ones via env to override.
if (-not $env:STUDIO_TOKEN) { $env:STUDIO_TOKEN = 'dev-studio-token' }
if (-not $env:RELOAD_TOKEN) { $env:RELOAD_TOKEN = 'dev-reload-token' }
if (-not $env:PLAYER_URL)  { $env:PLAYER_URL  = 'http://127.0.0.1:8791' }
$env:PORT = "$port"

Write-Host "starting studio on http://127.0.0.1:$port (player: $($env:PLAYER_URL))"
Write-Host "write token: $($env:STUDIO_TOKEN)  <- paste into the bottom-left box in the UI"
Start-Process -FilePath "node" -ArgumentList "studio\studio.mjs" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
Start-Sleep -Seconds 2
try {
    $h = Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 5
    Write-Host "studio up. player reachable: $($h.player.reachable); ollama: $($h.ollama.reachable)"
    Write-Host "NOTE: the player server needs RELOAD_TOKEN=$($env:RELOAD_TOKEN) for publish hot-reload to work."
} catch {
    Write-Host "studio did not answer on /api/health — check node output." -ForegroundColor Yellow
}
