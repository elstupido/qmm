# Start (or stop) the QMM demo server, detached from any terminal.
# Usage:  powershell -ExecutionPolicy Bypass -File C:\Users\marti\qmm\start-qmm.ps1 [-Stop]
param([switch]$Stop)

$port = 8791
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($Stop) {
    if ($listening) {
        $listening | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -Confirm:$false }
        Write-Host "QMM server stopped."
    } else { Write-Host "QMM server was not running." }
    exit 0
}

if ($listening) { Write-Host "QMM server already running on :$port (pid $($listening[0].OwningProcess))."; exit 0 }

# ollama runs as a Windows service / tray app; just verify it answers.
try { Invoke-RestMethod http://127.0.0.1:11434/api/version -TimeoutSec 5 | Out-Null }
catch { Write-Warning "ollama is not answering on 127.0.0.1:11434 - start ollama first."; exit 1 }

Start-Process node -ArgumentList "server\server.mjs" -WorkingDirectory $root -WindowStyle Hidden
Start-Sleep 2
try {
    $h = Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 10
    Write-Host "QMM demo up: http://127.0.0.1:$port  (model $($h.model), present=$($h.model_present), loaded=$($h.model_loaded))"
} catch {
    Write-Warning "Server did not answer health check: $($_.Exception.Message)"
    exit 1
}
