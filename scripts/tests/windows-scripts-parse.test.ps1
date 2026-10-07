# Run with powershell.exe or pwsh -NoProfile -File <this file>.
# Parses every PowerShell script under scripts/ (setup, launchers, helpers and
# tests) with the PowerShell parser. Nothing is executed; a syntax error in a
# script without its own regression test fails here instead of on a Windows PC.
$ErrorActionPreference = 'Stop'
$scriptsRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$files = @(Get-ChildItem -LiteralPath $scriptsRoot -Recurse -File -Filter '*.ps1' | Sort-Object FullName)
foreach ($required in @('setup.ps1', 'Start-TaxTronik.ps1', 'Start-SignalDev.ps1', 'docker-commands.ps1')) {
  if (-not ($files | Where-Object { $_.Name -eq $required })) { throw "Missing PowerShell script: $required" }
}
foreach ($file in $files) {
  $tokens = $null; $parseErrors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors) | Out-Null
  if ($parseErrors.Count -gt 0) {
    $first = $parseErrors[0]
    throw "$($file.FullName):$($first.Extent.StartLineNumber): $($first.Message)"
  }
}
Write-Output "$($files.Count) PowerShell scripts parse without errors."
