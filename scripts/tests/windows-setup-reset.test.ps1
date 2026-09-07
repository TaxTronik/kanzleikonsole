# Run with Windows PowerShell 5.1 or pwsh. Uses a disposable synthetic checkout
# and stub functions only; the real Docker daemon and repository .env are never accessed.
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../setup.ps1')).Path
$tokens = $null; $parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count -gt 0) { throw 'The Windows setup source must parse in this PowerShell version.' }
$fixtureBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixtureRoot = Join-Path $fixtureBase ('kk-windows-reset-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $fixtureRoot 'scripts') -Force | Out-Null
$original = 'SYNTHETIC_RESET_SENTINEL=preserve-this-fixture'
$fixtureEnv = Join-Path $fixtureRoot '.env'
[IO.File]::WriteAllText($fixtureEnv, $original)
Copy-Item -LiteralPath $source -Destination (Join-Path $fixtureRoot 'scripts/setup.ps1')
$wrapper = @'
param([string]$SetupPath, [string]$CallsPath)
function docker {
  if ($args[0] -eq 'info') { $global:LASTEXITCODE = 0; return }
  if ($args[0] -eq 'compose' -and $args -contains 'down') {
    [IO.File]::AppendAllText($CallsPath, 'reset-invoked')
    Write-Output 'Synthetic reset failure'
    $global:LASTEXITCODE = 31
    return
  }
  throw 'Unexpected Docker call in the isolated reset fixture.'
}
function pnpm {
  if ($args[0] -eq '--version') { Write-Output '11.20.0'; $global:LASTEXITCODE = 0; return }
  throw 'Dependency or database work must never start after failed reset.'
}
& $SetupPath -Reset -SkipSeed
if (-not $?) { exit 1 }
exit $LASTEXITCODE
'@
$wrapperPath = Join-Path $fixtureRoot 'run.ps1'
[IO.File]::WriteAllText($wrapperPath, $wrapper)
try {
  $shellPath = (Get-Process -Id $PID).Path
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $shellPath -NoProfile -ExecutionPolicy Bypass -File $wrapperPath (Join-Path $fixtureRoot 'scripts/setup.ps1') (Join-Path $fixtureRoot 'reset-called') *> (Join-Path $fixtureRoot 'execution.log')
    $childExit = $LASTEXITCODE
  } finally { $ErrorActionPreference = $oldPreference }
  if ($childExit -eq 0) { throw 'A failed reset must fail the setup.' }
  if (-not (Test-Path -LiteralPath (Join-Path $fixtureRoot 'reset-called'))) { throw 'The reset scenario was not reached.' }
  if (-not (Test-Path -LiteralPath $fixtureEnv)) { throw 'A failed Docker reset deleted the existing .env.' }
  if ([IO.File]::ReadAllText($fixtureEnv) -ne $original) { throw 'A failed reset changed the existing .env.' }
  Write-Output 'Windows setup reset failure preserves the existing configuration.'
} finally {
  $resolvedFixture = (Resolve-Path -LiteralPath $fixtureRoot).Path
  if ($resolvedFixture -ne [IO.Path]::GetFullPath($fixtureRoot) -or -not $resolvedFixture.StartsWith($fixtureBase, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolvedFixture) -notmatch '^kk-windows-reset-test-[0-9a-f]{32}$') {
    throw 'Refusing cleanup outside the synthetic reset fixture.'
  }
  Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}
