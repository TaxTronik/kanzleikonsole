#requires -version 5.1
# =============================================================================
# TaxTronik — lokaler Container-Dev-Helfer für Windows.
#
# Kein Produktionsstarter und nicht der normale Windows-Setup-Pfad. Für die
# lokale Entwicklung ist `.\scripts\setup.ps1` maßgeblich; danach laufen Web
# und Worker üblicherweise über `pnpm ... dev`.
#
# Dieses Skript ist nur ein Shortcut für den containerisierten lokalen
# App-/Worker-Stack. Beim ersten Lauf: Secrets generieren, Images bauen.
# Folgestarts: nur `up`.
#
#   powershell -ExecutionPolicy Bypass -File scripts\win\Start-TaxTronik.ps1
#
# Schalter:
#   -Build       Images neu bauen (sonst nur, wenn sie fehlen)
#   -NoBrowser   Browser nicht automatisch öffnen
# =============================================================================
[CmdletBinding()]
param(
  [switch]$Build,
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'

# --- Pfade -------------------------------------------------------------------
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root        = (Resolve-Path (Join-Path $ScriptDir '..\..')).Path
Set-Location $Root
$EnvFile     = Join-Path $Root '.env'
$Base        = 'infra\compose\docker-compose.yml'
$App         = 'infra\compose\docker-compose.app.yml'
$S3Generated = Join-Path $Root 'infra\scripts\seaweedfs-s3.generated.json'

function Info($m){ Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)  { Write-Host "    ok: $m" -ForegroundColor Green }
function Warn($m){ Write-Host "    !! $m" -ForegroundColor Yellow }
function Die($m) { Write-Host $m -ForegroundColor Red; exit 1 }

# Native Ausgabe und Exitstatus dürfen nicht im selben Rückgabewert landen.
. (Join-Path $PSScriptRoot 'docker-commands.ps1')

# --- .env lesen/schreiben ----------------------------------------------------
# Gemeinsame Hilfe scripts/env-tool.mjs (wie setup.sh/setup.ps1): Werte werden
# woertlich geschrieben, nie per Kommandozeile uebergeben, UTF-8 ohne BOM.
# Secrets sind base64url. Bekannte Dev-/CI-Defaults kommen aus
# packages/config/src/dev-default-secrets.json, derselben Liste wie das
# Prod-Gate: Im Container laeuft NODE_ENV=production und lehnt solche Werte ab.
$EnvTool = Join-Path $Root 'scripts\env-tool.mjs'
function Invoke-EnvTool {
  $output = & node $EnvTool @args
  if ($LASTEXITCODE -ne 0) { Die "env-tool $($args[0]) fehlgeschlagen (Exit $LASTEXITCODE)." }
  return [string]$output
}
function Get-EnvVal($key){ return (Invoke-EnvTool get $EnvFile $key) }
function Set-EnvVal($key,$value){
  $env:ENV_TOOL_VALUE = $value
  try { $null = Invoke-EnvTool set $EnvFile $key } finally { Remove-Item Env:ENV_TOOL_VALUE -ErrorAction SilentlyContinue }
}
# Leere Werte fuellen; mit -ReplaceWeak auch bekannte Defaults ersetzen (sonst
# bootet app/worker nicht). Ohne -ReplaceWeak nur warnen: Datenbank-, S3- und
# n8n-DB-Zugaenge sind in bestehenden Volumes hinterlegt.
function Ensure-Secret($key,$bytes,[switch]$ReplaceWeak){
  $toolArgs = @('ensure', $EnvFile, $key, $bytes)
  if ($ReplaceWeak) { $toolArgs += '--replace-weak' }
  $result = Invoke-EnvTool @toolArgs
  if ($result -eq 'generated' -or $result -eq 'replaced') { Ok "$key generiert/ersetzt." }
  elseif ($result -eq 'weak') { Warn "$key ist ein bekannter Dev-/CI-Default; das Prod-Gate im Container lehnt ihn ab (docs/operations/secret-rotation.md)." }
}

# --- 1. Docker ---------------------------------------------------------------
Info "Docker prüfen"
if (-not (Test-Docker)) {
  $dd = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path -LiteralPath $dd) {
    Warn "Docker läuft nicht — starte Docker Desktop und warte (bis zu 3 min) …"
    Start-Process -FilePath $dd | Out-Null
    $deadline = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $deadline -and -not (Test-Docker)) { Start-Sleep -Seconds 3 }
  }
  if (-not (Test-Docker)) { Die "Docker ist nicht erreichbar. Bitte Docker Desktop starten und erneut ausfuehren." }
}
Ok "Docker laeuft."

# --- 2. .env + Secrets -------------------------------------------------------
Info ".env vorbereiten"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "Node.js fehlt. Bitte Node.js 24 installieren (siehe .nvmrc)." }
if (-not (Test-Path -LiteralPath $EnvFile)) {
  Copy-Item -LiteralPath (Join-Path $Root '.env.example') -Destination $EnvFile
  Ok ".env aus .env.example angelegt."
}
Ensure-Secret 'AUTH_SECRET'           32 -ReplaceWeak
Ensure-Secret 'N8N_HMAC_SECRET'       32 -ReplaceWeak
Ensure-Secret 'N8N_ENCRYPTION_KEY'    24 -ReplaceWeak
Ensure-Secret 'POSTGRES_PASSWORD'     24
Ensure-Secret 'TAXTRONIK_APP_PASSWORD' 24
Ensure-Secret 'S3_ACCESS_KEY'         16
Ensure-Secret 'S3_SECRET_KEY'         32
Ensure-Secret 'N8N_DB_PASSWORD'       24
# DB-URLs für Host-Werkzeuge (die Container bekommen ihre URLs aus der Compose).
$pgpw = Get-EnvVal 'POSTGRES_PASSWORD'
$apw  = Get-EnvVal 'TAXTRONIK_APP_PASSWORD'
Set-EnvVal 'DATABASE_URL'     "postgresql://taxtronik:$pgpw@localhost:5432/taxtronik?schema=public"
Set-EnvVal 'DATABASE_APP_URL' "postgresql://taxtronik_app:$apw@localhost:5432/taxtronik?schema=public"
Ok ".env bereit."

# --- 3. Historische Host-Secret-Datei entfernen -------------------------------
# SeaweedFS rendert die Config im Container nach /run (UID 1000, 0400).
if (Test-Path -LiteralPath $S3Generated) { Remove-Item -LiteralPath $S3Generated -Force }

# --- 4. Images sicherstellen -------------------------------------------------
$prefix = Get-EnvVal 'TAXTRONIK_IMAGE_PREFIX'; if (-not $prefix) { $prefix = 'taxtronik' }
$ver    = Get-EnvVal 'TAXTRONIK_VERSION';      if (-not $ver)    { $ver = 'dev' }
$webImg = "$prefix/web:$ver"; $workerImg = "$prefix/worker:$ver"
if ($Build -or -not (Image-Exists $webImg) -or -not (Image-Exists $workerImg)) {
  Info "Images bauen ($webImg, $workerImg) — erster Lauf dauert einige Minuten"
  if ((Run-Docker build -f 'infra\docker\Dockerfile.web'    -t $webImg    '.') -ne 0) { Die "Build des web-Images fehlgeschlagen." }
  if ((Run-Docker build -f 'infra\docker\Dockerfile.worker' -t $workerImg '.') -ne 0) { Die "Build des worker-Images fehlgeschlagen." }
  Ok "Images gebaut."
} else {
  Ok "Images vorhanden ($webImg, $workerImg)."
}

# --- 5. Stack hochfahren -----------------------------------------------------
# SeaweedFS-Host-Ports: Windows (Hyper-V/WSL) reserviert oft 8333/9333 → freie
# Defaults setzen, falls in der .env nicht überschrieben. Nur für Host-Zugriff;
# die App nutzt seaweedfs:8333 intern (Container-Netz), unabhängig davon.
if (-not (Get-EnvVal 'SEAWEED_S3_PORT'))     { $env:SEAWEED_S3_PORT     = '38333' }
if (-not (Get-EnvVal 'SEAWEED_MASTER_PORT')) { $env:SEAWEED_MASTER_PORT = '39333' }
if (-not (Get-EnvVal 'SEAWEED_FILER_PORT'))  { $env:SEAWEED_FILER_PORT  = '38888' }

Info "Stack starten (Infra + App + Worker + n8n; Migrationen via migrate-Service)"
if ((Run-Docker compose --env-file '.env' -f $Base -f $App up -d) -ne 0) { Die "docker compose up fehlgeschlagen." }
Ok "Container laufen."

# --- 6. Health abwarten ------------------------------------------------------
$port = Get-EnvVal 'APP_BIND_PORT'; if (-not $port) { $port = '3000' }
$url  = "http://127.0.0.1:$port/api/health"
Info "Warte auf App-Health ($url)"
$ready = $false
$deadline = (Get-Date).AddSeconds(180)
while ((Get-Date) -lt $deadline) {
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 5
    if ($resp.StatusCode -eq 200) { $ready = $true; break }
  } catch {
    # 503 = 'degraded' (App laeuft, eine Abhaengigkeit flackert) → trotzdem erreichbar.
    if ($_.Exception.Response -and ([int]$_.Exception.Response.StatusCode) -eq 503) { $ready = $true; break }
  }
  Start-Sleep -Seconds 3
}
if ($ready) { Ok "App ist erreichbar." } else { Warn "App-Health nicht bestaetigt — Container fahren evtl. noch hoch. Logs: docker compose --env-file .env -f $Base -f $App logs app --tail 80" }

# --- 7. Fertig ---------------------------------------------------------------
$loginUrl = "http://localhost:$port/staff/login"
if (-not $NoBrowser) { Start-Process $loginUrl }
Write-Host ""
Write-Host "TaxTronik lokaler Container-Dev-Stack laeuft:  $loginUrl" -ForegroundColor Green
Write-Host "Stoppen:           docker compose --env-file .env -f $Base -f $App down" -ForegroundColor DarkGray
Write-Host "Hinweis: Kein Produktionsstarter. Prod nutzt ./taxtronik bootstrap/deploy." -ForegroundColor DarkGray
