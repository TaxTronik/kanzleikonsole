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
$S3Template  = Join-Path $Root 'infra\scripts\seaweedfs-s3.template.json'
$S3Generated = Join-Path $Root 'infra\scripts\seaweedfs-s3.generated.json'

function Info($m){ Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)  { Write-Host "    ok: $m" -ForegroundColor Green }
function Warn($m){ Write-Host "    !! $m" -ForegroundColor Yellow }
function Die($m) { Write-Host $m -ForegroundColor Red; exit 1 }

# Native docker-Aufrufe von $ErrorActionPreference='Stop' entkoppeln (docker
# schreibt Fortschritt auf stderr; das würde sonst das Skript abbrechen).
function Run-Docker {
  param([Parameter(ValueFromRemainingArguments=$true)][string[]]$DockerArgs)
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & docker @DockerArgs; return $LASTEXITCODE } finally { $ErrorActionPreference = $old }
}
function Test-Docker  { cmd /c "docker info >NUL 2>NUL";            return ($LASTEXITCODE -eq 0) }
function Image-Exists { param($ref) cmd /c "docker image inspect $ref >NUL 2>NUL"; return ($LASTEXITCODE -eq 0) }

# base64url-Secret (RFC 4648 §5) — '+/=' würden in DATABASE_URL/JSON Probleme machen.
function New-Secret([int]$bytes){
  $b = New-Object byte[] $bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($b) } finally { $rng.Dispose() }
  ([Convert]::ToBase64String($b)) -replace '\+','-' -replace '/','_' -replace '=',''
}

# --- .env lesen/schreiben ----------------------------------------------------
function Read-EnvMap {
  $map = @{}
  if (Test-Path -LiteralPath $EnvFile) {
    foreach($line in @(Get-Content -LiteralPath $EnvFile)){
      if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
      $parts = $line -split '=',2
      $k = $parts[0].Trim()
      if ($k) { $map[$k] = $parts[1] }
    }
  }
  return $map
}
function Get-EnvVal($map,$key){ if($map.ContainsKey($key)){ return $map[$key] } else { return '' } }
function Set-EnvVal($key,$value){
  $lines = @()
  if (Test-Path -LiteralPath $EnvFile) { $lines = @(Get-Content -LiteralPath $EnvFile) }
  $found = $false
  for($i=0; $i -lt $lines.Count; $i++){
    if ($lines[$i] -match "^\s*$([regex]::Escape($key))\s*="){ $lines[$i] = "$key=$value"; $found = $true; break }
  }
  if (-not $found){ $lines += "$key=$value" }
  $enc = New-Object System.Text.UTF8Encoding($false)   # UTF-8 OHNE BOM (sonst bricht die 1. Zeile)
  [System.IO.File]::WriteAllLines($EnvFile, [string[]]$lines, $enc)
}
# Bekannte Dev-Default-Werte (Spiegel der Denylist in packages/config/src/env.ts).
# Im Container läuft NODE_ENV=production → das Prod-Gate LEHNT solche Werte ab.
# Daher ersetzen, nicht nur leere Felder füllen (sonst bootet app/worker nicht).
$DevDefaults = @{
  'AUTH_SECRET'        = @('taxtronik-dev-auth-secret-change-in-production-please','changeme','secret')
  'N8N_HMAC_SECRET'    = @('dev-only-hmac-secret-min-32-chars-long-xxx')
  'N8N_ENCRYPTION_KEY' = @('dev-only-n8n-encryption-key-xxxxxxxx')
}
function Test-WeakSecret($key,$val){
  if (-not $val) { return $true }
  if ($DevDefaults.ContainsKey($key) -and ($DevDefaults[$key] -contains $val)) { return $true }
  if ($key -eq 'AUTH_SECRET' -and ($val -match '^(password|secret|admin|test)' -or $val -match '^(.)\1{8,}')) { return $true }
  return $false
}
function Ensure-Secret($key,$bytes){
  $m = Read-EnvMap
  if (Test-WeakSecret $key (Get-EnvVal $m $key)) { Set-EnvVal $key (New-Secret $bytes); Ok "$key generiert/ersetzt." }
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
if (-not (Test-Path -LiteralPath $EnvFile)) {
  Copy-Item -LiteralPath (Join-Path $Root '.env.example') -Destination $EnvFile
  Ok ".env aus .env.example angelegt."
}
Ensure-Secret 'AUTH_SECRET'           32
Ensure-Secret 'N8N_HMAC_SECRET'       32
Ensure-Secret 'N8N_ENCRYPTION_KEY'    24
Ensure-Secret 'POSTGRES_PASSWORD'     24
Ensure-Secret 'TAXTRONIK_APP_PASSWORD' 24
Ensure-Secret 'S3_ACCESS_KEY'         16
Ensure-Secret 'S3_SECRET_KEY'         32
Ensure-Secret 'N8N_DB_PASSWORD'       24
# DB-URLs für Host-Werkzeuge (die Container bekommen ihre URLs aus der Compose).
$m = Read-EnvMap
$pgpw = Get-EnvVal $m 'POSTGRES_PASSWORD'
$apw  = Get-EnvVal $m 'TAXTRONIK_APP_PASSWORD'
Set-EnvVal 'DATABASE_URL'     "postgresql://taxtronik:$pgpw@localhost:5432/taxtronik?schema=public"
Set-EnvVal 'DATABASE_APP_URL' "postgresql://taxtronik_app:$apw@localhost:5432/taxtronik?schema=public"
Ok ".env bereit."

# --- 3. SeaweedFS-S3-Config rendern (sonst stirbt der Container) --------------
Info "SeaweedFS-S3-Config rendern"
$m = Read-EnvMap
$tpl = Get-Content -LiteralPath $S3Template -Raw
$tpl = $tpl.Replace('__S3_ACCESS_KEY__', (Get-EnvVal $m 'S3_ACCESS_KEY')).Replace('__S3_SECRET_KEY__', (Get-EnvVal $m 'S3_SECRET_KEY'))
[System.IO.File]::WriteAllText($S3Generated, $tpl, (New-Object System.Text.UTF8Encoding($false)))
Ok "s3.generated.json gerendert."

# --- 4. Images sicherstellen -------------------------------------------------
$m = Read-EnvMap
$prefix = Get-EnvVal $m 'TAXTRONIK_IMAGE_PREFIX'; if (-not $prefix) { $prefix = 'taxtronik' }
$ver    = Get-EnvVal $m 'TAXTRONIK_VERSION';      if (-not $ver)    { $ver = 'dev' }
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
$m = Read-EnvMap
if (-not (Get-EnvVal $m 'SEAWEED_S3_PORT'))     { $env:SEAWEED_S3_PORT     = '38333' }
if (-not (Get-EnvVal $m 'SEAWEED_MASTER_PORT')) { $env:SEAWEED_MASTER_PORT = '39333' }
if (-not (Get-EnvVal $m 'SEAWEED_FILER_PORT'))  { $env:SEAWEED_FILER_PORT  = '38888' }

Info "Stack starten (Infra + App + Worker + n8n; Migrationen via migrate-Service)"
if ((Run-Docker compose --env-file '.env' -f $Base -f $App up -d) -ne 0) { Die "docker compose up fehlgeschlagen." }
Ok "Container laufen."

# --- 6. Health abwarten ------------------------------------------------------
$m = Read-EnvMap
$port = Get-EnvVal $m 'APP_BIND_PORT'; if (-not $port) { $port = '3000' }
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
