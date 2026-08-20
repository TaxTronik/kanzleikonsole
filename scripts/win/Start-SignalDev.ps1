#requires -version 5.1
<#
.SYNOPSIS
  Starts the sibling Signal checkout for local TaxTronik development.

.DESCRIPTION
  Keeps TaxTronik and Signal on the same bearer/operator credentials, installs
  the hash-pinned Windows/Python-3.12 CPU embedding runtime when needed, and
  starts the native /v1 engine. Secrets are written to TaxTronik's gitignored
  .env and are never printed.
#>
[CmdletBinding()]
param(
  [string]$SignalRoot = '',
  [switch]$SkipEmbeddingInstall,
  [switch]$NoLlmAutostart
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = [IO.Path]::GetFullPath((Join-Path $ScriptDir '..\..'))
$EnvFile = Join-Path $Root '.env'
$script:EnvChanged = $false

function Info([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Ok([string]$Message) { Write-Host "    ok: $Message" -ForegroundColor Green }
function Warn([string]$Message) { Write-Host "    !! $Message" -ForegroundColor Yellow }
function Fail([string]$Message) { throw $Message }

function New-Secret([int]$Bytes) {
  $buffer = New-Object byte[] $Bytes
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  return (([Convert]::ToBase64String($buffer)) -replace '\+','-' -replace '/','_' -replace '=','')
}

function Read-EnvMap {
  $map = @{}
  if (Test-Path -LiteralPath $EnvFile) {
    foreach ($line in @(Get-Content -LiteralPath $EnvFile)) {
      if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
      $parts = $line -split '=', 2
      $key = $parts[0].Trim()
      if ($key) { $map[$key] = $parts[1].Trim() }
    }
  }
  return $map
}

function Get-EnvValue($Map, [string]$Key) {
  if (-not $Map.ContainsKey($Key)) { return '' }
  $value = [string]$Map[$Key]
  if ($value.Length -ge 2) {
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      return $value.Substring(1, $value.Length - 2)
    }
  }
  return $value
}

function Set-EnvValue([string]$Key, [string]$Value) {
  $lines = @()
  if (Test-Path -LiteralPath $EnvFile) {
    $lines = @(Get-Content -LiteralPath $EnvFile)
  }
  $found = $false
  $changed = $false
  for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index] -match "^\s*$([regex]::Escape($Key))\s*=") {
      $replacement = "$Key=$Value"
      if ($lines[$index] -cne $replacement) {
        $lines[$index] = $replacement
        $changed = $true
      }
      $found = $true
      break
    }
  }
  if (-not $found) {
    $lines += "$Key=$Value"
    $changed = $true
  }
  if ($changed) {
    $encoding = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllLines($EnvFile, [string[]]$lines, $encoding)
    $script:EnvChanged = $true
  }
}

function Test-Token([string]$Value) {
  return ($Value -notmatch '[\r\n]' -and [Text.Encoding]::UTF8.GetByteCount($Value) -ge 32)
}

if (-not (Test-Path -LiteralPath $EnvFile)) {
  Copy-Item -LiteralPath (Join-Path $Root '.env.example') -Destination $EnvFile
  $script:EnvChanged = $true
}

if (-not $SignalRoot) {
  $SignalRoot = [IO.Path]::GetFullPath((Join-Path $Root '..\signal'))
} else {
  $SignalRoot = [IO.Path]::GetFullPath($SignalRoot)
}
if (-not (Test-Path -LiteralPath (Join-Path $SignalRoot 'risk_layer\web.py') -PathType Leaf)) {
  Fail "Signal checkout not found at '$SignalRoot'. Use -SignalRoot to select it."
}
if (-not (Test-Path -LiteralPath (Join-Path $SignalRoot 'corpus\graph.sqlite') -PathType Leaf)) {
  Fail "Signal norm graph is missing. Run Signal scripts\setup.ps1 once."
}

Info 'TaxTronik development credentials'
$values = Read-EnvMap
$bearerToken = Get-EnvValue $values 'RISK_LAYER_TOKEN'
if (-not (Test-Token $bearerToken)) {
  $bearerToken = New-Secret 32
  Set-EnvValue 'RISK_LAYER_TOKEN' $bearerToken
  Ok 'RISK_LAYER_TOKEN generated (not displayed).'
}
$operatorToken = Get-EnvValue $values 'RISK_LAYER_OPERATOR_TOKEN'
if (-not (Test-Token $operatorToken) -or $operatorToken -ceq $bearerToken) {
  $operatorToken = New-Secret 32
  Set-EnvValue 'RISK_LAYER_OPERATOR_TOKEN' $operatorToken
  Ok 'Separate RISK_LAYER_OPERATOR_TOKEN generated (not displayed).'
}
Set-EnvValue 'SIGNAL_DEPLOYMENT' 'external'
Set-EnvValue 'RISK_LAYER_URL' 'http://127.0.0.1:8000'
Set-EnvValue 'RISK_LAYER_EMB_DEVICE' 'cpu'
Set-EnvValue 'RISK_LAYER_LLM_BACKEND' 'auto'
Set-EnvValue 'RISK_LAYER_LLM_TIMEOUT' '900'
if ($script:EnvChanged) {
  Warn '.env changed. Restart already-running TaxTronik web and worker processes.'
} else {
  Ok '.env already matches the local Signal process.'
}

$python = Join-Path $SignalRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
  Info 'Create isolated Signal Python 3.12 environment'
  & py -3.12 -m venv (Join-Path $SignalRoot '.venv')
  if ($LASTEXITCODE -ne 0) { Fail 'Python 3.12 venv creation failed.' }
}

$pythonVersion = [string](& $python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
$pythonVersion = $pythonVersion.Trim()
if ($LASTEXITCODE -ne 0 -or $pythonVersion -ne '3.12') {
  Fail "The pinned Windows embedding runtime requires Python 3.12 (found $pythonVersion)."
}

Push-Location $SignalRoot
try {
  & $python -c 'import risk_layer' 2>$null
  if ($LASTEXITCODE -ne 0) {
    Info 'Install Signal runtime into its development environment'
    & $python -m pip install --require-hashes --only-binary=:all: -r 'requirements-runtime-lock.txt'
    if ($LASTEXITCODE -ne 0) { Fail 'Pinned Signal runtime installation failed.' }
    & $python -m pip install --no-build-isolation --no-deps -e .
    if ($LASTEXITCODE -ne 0) { Fail 'Signal development package installation failed.' }
  }

  & $python -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('sentence_transformers') and importlib.util.find_spec('torch') else 1)" 2>$null
  $embeddingInstalled = ($LASTEXITCODE -eq 0)
  if (-not $embeddingInstalled) {
    if ($SkipEmbeddingInstall) {
      Fail 'Embedding runtime is missing. Remove -SkipEmbeddingInstall to install the pinned CPU stack.'
    }
    Info 'Install hash-pinned CPU embedding runtime (first run can take several minutes)'
    & $python -m pip install --require-hashes --only-binary=:all: -r 'requirements-embedding-windows-cpu-py312-lock.txt'
    if ($LASTEXITCODE -ne 0) { Fail 'Pinned CPU embedding runtime installation failed.' }
  }
  & $python -m pip check
  if ($LASTEXITCODE -ne 0) { Fail 'Signal Python environment is inconsistent (pip check failed).' }
  Ok 'CPU embedding runtime is available.'

  $embeddingDir = Join-Path $SignalRoot '.signal\embedding'
  [void][IO.Directory]::CreateDirectory($embeddingDir)
  $env:RISK_LAYER_TOKEN = $bearerToken
  $env:RISK_LAYER_OPERATOR_TOKEN = $operatorToken
  $env:RISK_LAYER_EMBEDDING_DIR = $embeddingDir
  $env:RISK_LAYER_EMB_DEVICE = 'cpu'
  $env:RISK_LAYER_LLM_BACKEND = 'auto'
  $env:RISK_LAYER_LLM_TIMEOUT = '900'

  Info 'Start Signal at http://127.0.0.1:8000'
  Write-Host '    CPU embedding builds can be slow; the LLM backend uses automatic detection.' -ForegroundColor Yellow
  $arguments = @('-m', 'risk_layer.web', '--host', '127.0.0.1', '--port', '8000', '--graph', 'corpus/graph.sqlite')
  if (-not $NoLlmAutostart) { $arguments += '--llm-autostart' }
  & $python @arguments
  if ($LASTEXITCODE -ne 0) { Fail "Signal exited with code $LASTEXITCODE." }
} finally {
  Pop-Location
}
