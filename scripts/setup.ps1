# =============================================================================
# taxtronik Setup — One-Command-Deploy für Windows.
#
# Voraussetzung: Docker Desktop installiert und gestartet.
#
#   .\scripts\setup.ps1            (vollständiges Setup)
#   .\scripts\setup.ps1 -Reset     (alles zurücksetzen, dann neu)
#   .\scripts\setup.ps1 -SkipSeed  (kein Demo-Seed)
# =============================================================================

[CmdletBinding()]
param(
  [switch]$Reset,
  [switch]$SkipSeed
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

function Write-Step($msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}
function Write-Done($msg) {
  Write-Host "    ok: $msg" -ForegroundColor Green
}
function Write-Warn($msg) {
  Write-Host "    !! $msg" -ForegroundColor Yellow
}

function New-RandomSecret([int]$bytes = 32) {
  # N-1: base64url (RFC 4648 §5) statt Standard-Base64. Die generierten Werte
  # landen u. a. in DATABASE_URL=postgresql://user:${pw}@host/db — ein '/' im
  # Passwort würde den Password-Teil der URL terminieren und ~40% der Setups
  # zerschneiden. base64url tauscht '+/' gegen '-_', '=' wird ohnehin gestrippt.
  $arr = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($arr)
  return [Convert]::ToBase64String($arr).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# -------------------------------------------------------------------- Vorprüfungen
Write-Step "Vorprüfungen"

$dockerOk = $false
try {
  $null = & docker info 2>&1
  if ($LASTEXITCODE -eq 0) { $dockerOk = $true }
} catch {}
if (-not $dockerOk) {
  Write-Host "Docker Desktop ist nicht erreichbar." -ForegroundColor Red
  Write-Host "Bitte Docker Desktop starten und dann dieses Skript erneut ausführen."
  exit 1
}
Write-Done "Docker läuft."

$pnpmOk = $false
try {
  $null = & pnpm --version 2>&1
  if ($LASTEXITCODE -eq 0) { $pnpmOk = $true }
} catch {}
if (-not $pnpmOk) {
  Write-Host "pnpm nicht gefunden. Bitte installieren:" -ForegroundColor Red
  Write-Host "  npm install -g pnpm"
  exit 1
}
Write-Done "pnpm verfügbar."

# -------------------------------------------------------------------- Reset
if ($Reset) {
  Write-Step "Reset — Stack stoppen + Volumes löschen"
  & docker compose --env-file .env -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.dev.yml down -v
  if (Test-Path .env) { Remove-Item .env }
  Write-Done "Stack zurückgesetzt."
}

# -------------------------------------------------------------------- .env
Write-Step ".env vorbereiten"
$envCreated = $false
if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  $envCreated = $true
  Write-Done ".env aus .env.example angelegt."
}

$envContent = Get-Content .env -Raw

function Set-EnvVar([string]$key, [string]$value) {
  if ($script:envContent -match "(?m)^$key=") {
    $script:envContent = $script:envContent -replace "(?m)^$key=.*$", "$key=$value"
  } else {
    $script:envContent = $script:envContent.TrimEnd() + "`n$key=$value`n"
  }
}
function Get-EnvVar([string]$key) {
  if ($script:envContent -match "(?m)^$key=(.*)$") { return $Matches[1].Trim('"') } else { return "" }
}
function Ensure-Secret([string]$key, [int]$bytes) {
  $current = Get-EnvVar $key
  if (-not $current) {
    Set-EnvVar $key (New-RandomSecret $bytes)
    Write-Done "$key generiert."
  }
}

# Auth / HMAC / Verschlüsselung
Ensure-Secret 'AUTH_SECRET'           32
if ($envCreated) {
  Ensure-Secret 'SECRET_BOX_KEY'      32
} elseif (-not (Get-EnvVar 'SECRET_BOX_KEY')) {
  Write-Warn 'SECRET_BOX_KEY fehlt in bestehender .env; vor dem Setzen Bestands-Secrets migrieren (docs/operations/secret-rotation.md).'
}
Ensure-Secret 'N8N_HMAC_SECRET'       32
Ensure-Secret 'N8N_ENCRYPTION_KEY'    24

# Bestehende Installation: Passwort aus DATABASE_URL übernehmen, falls eines
# darin steht. Greift nur, wenn POSTGRES_PASSWORD leer ist.
function Extract-PwFromUrl([string]$url) {
  if ($url -match '^postgres(?:ql)?://[^:]+:([^@]+)@') { return $Matches[1] } else { return $null }
}
if (-not (Get-EnvVar 'POSTGRES_PASSWORD')) {
  $existing = Extract-PwFromUrl (Get-EnvVar 'DATABASE_URL')
  if ($existing -and $existing -ne '${POSTGRES_PASSWORD}') {
    Set-EnvVar 'POSTGRES_PASSWORD' $existing
    Write-Done "POSTGRES_PASSWORD aus bestehender DATABASE_URL übernommen."
  }
}
if (-not (Get-EnvVar 'TAXTRONIK_APP_PASSWORD')) {
  $existing = Extract-PwFromUrl (Get-EnvVar 'DATABASE_APP_URL')
  if ($existing -and $existing -ne '${TAXTRONIK_APP_PASSWORD}') {
    Set-EnvVar 'TAXTRONIK_APP_PASSWORD' $existing
    Write-Done "TAXTRONIK_APP_PASSWORD aus bestehender DATABASE_APP_URL übernommen."
  }
}

# Infrastruktur-Passwörter (nur generieren, wenn noch nicht aus URL übernommen)
Ensure-Secret 'POSTGRES_PASSWORD'        24
Ensure-Secret 'TAXTRONIK_APP_PASSWORD'   24
Ensure-Secret 'S3_SECRET_KEY'            32
Ensure-Secret 'N8N_DB_PASSWORD'          24

# DATABASE_URL / DATABASE_APP_URL mit den generierten Passwörtern befüllen.
# Wir behalten Host/Port aus dem aktuellen Wert (Dev: localhost, Compose: postgres)
# und ersetzen nur den Passwort-Anteil.
$pgPw  = Get-EnvVar 'POSTGRES_PASSWORD'
$appPw = Get-EnvVar 'TAXTRONIK_APP_PASSWORD'

# Erste Inbetriebnahme: ENV bekommt fertige URLs mit konkretem Passwort,
# damit die App (außerhalb von Docker) sich verbinden kann. In Docker werden
# die URLs in docker-compose.app.yml aus den ENV-Vars zusammengesetzt.
$dbUrl  = "postgresql://taxtronik:$pgPw@localhost:5432/taxtronik?schema=public"
$appUrl = "postgresql://taxtronik_app:$appPw@localhost:5432/taxtronik?schema=public"
Set-EnvVar 'DATABASE_URL' $dbUrl
Set-EnvVar 'DATABASE_APP_URL' $appUrl
Write-Done "DATABASE_URL und DATABASE_APP_URL gesetzt."

Set-Content .env -Value $envContent -Encoding utf8 -NoNewline

# SeaweedFS rendert die S3-Konfiguration beim Containerstart fluechtig nach
# /run. Historische Secret-Kopie aus dem Checkout entfernen.
$outPath = Join-Path $RepoRoot 'infra\scripts\seaweedfs-s3.generated.json'
if (Test-Path -LiteralPath $outPath) { Remove-Item -LiteralPath $outPath -Force }

# -------------------------------------------------------------------- Docker-Stack
Write-Step "Docker-Stack hochfahren (Postgres, Redis, SeaweedFS, ClamAV, Mailhog, n8n)"
& docker compose --env-file .env -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.dev.yml up -d
if ($LASTEXITCODE -ne 0) { Write-Host "Docker compose fehlgeschlagen." -ForegroundColor Red; exit 1 }
Write-Done "Container laufen."

Write-Step "Warten, bis Postgres healthy ist"
$deadline = (Get-Date).AddMinutes(2)
while ((Get-Date) -lt $deadline) {
  $status = & docker inspect --format '{{.State.Health.Status}}' taxtronik-postgres 2>$null
  if ($status -eq 'healthy') { Write-Done "Postgres healthy."; break }
  Start-Sleep -Seconds 2
}

# -------------------------------------------------------------------- pnpm install
Write-Step "Node-Abhängigkeiten installieren"
& pnpm install --silent --prod=false
if ($LASTEXITCODE -ne 0) { Write-Host "pnpm install fehlgeschlagen." -ForegroundColor Red; exit 1 }
Write-Done "Pakete installiert."

# -------------------------------------------------------------------- Prisma
Write-Step "Datenbank-Migrationen anwenden"
& pnpm db:migrate:deploy
if ($LASTEXITCODE -ne 0) { Write-Host "Migration fehlgeschlagen." -ForegroundColor Red; exit 1 }
Write-Done "Schema aktuell."

if (-not $SkipSeed) {
  # U-3: NODE_ENV=production → kein Dev-Seed. Der Seed selbst lehnt das auch
  # ab (exit 1), aber wir geben dem Operator vorher einen klaren Hinweis.
  $detectedEnv = (Get-EnvVar 'NODE_ENV')
  if ($detectedEnv -eq 'production') {
    Write-Warn 'Demo-Seed übersprungen: NODE_ENV=production in .env erkannt.'
    Write-Warn 'Für Production bitte einen dedizierten Provisionierungs-Pfad nutzen.'
  } else {
    Write-Step "Demo-Seed einspielen"
    & pnpm --filter '@taxtronik/db' run seed
    if ($LASTEXITCODE -eq 0) {
      Write-Done "Seed geladen."
    } else {
      Write-Warn "Seed übersprungen (Skript hat Fehler gemeldet)."
    }
  }
}

# Object-Store-Buckets werden vom `seaweedfs-init`-Container automatisch
# angelegt (siehe docker-compose.yml) — kein manueller Aufruf nötig.
Write-Step "Object-Store-Buckets (SeaweedFS)"
Start-Sleep -Seconds 3
$initStatus = & docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' taxtronik-seaweedfs-init 2>$null
Write-Done "Init-Container Status: $initStatus"

# -------------------------------------------------------------------- Fertig
Write-Host ""
Write-Host "===============================================================" -ForegroundColor Green
Write-Host "  Setup abgeschlossen." -ForegroundColor Green
Write-Host "===============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Nächste Schritte:" -ForegroundColor White
Write-Host "  1. Dev-Server starten:   pnpm --filter @taxtronik/web dev"
Write-Host "  2. Worker starten:       pnpm --filter @taxtronik/worker dev"
Write-Host "  3. Login: http://localhost:3000/staff/login"
Write-Host "     (Demo-Admin aus Seed: siehe README)"
Write-Host ""
Write-Host "Hilfsdienste:" -ForegroundColor White
Write-Host "  - SeaweedFS-Master: http://localhost:9333"
Write-Host "  - SeaweedFS-Filer:  http://localhost:8888"
Write-Host "  - Mailhog-UI:       http://localhost:8025"
Write-Host "  - n8n:              http://localhost:5678"
Write-Host ""
