# Run with powershell.exe or pwsh -NoProfile -File <this file>.
# Docker is replaced with an in-process stub: no daemon, filesystem or network changes.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../win/docker-commands.ps1')

$script:dockerCalls = @()
$script:dockerExitCode = 0
$script:checks = 0
function docker {
  $script:dockerCalls += ,@($args)
  Write-Output 'Synthetic Docker progress'
  $global:LASTEXITCODE = $script:dockerExitCode
}

function Assert-True([bool]$condition, [string]$message) {
  if (-not $condition) { throw $message }
  $script:checks++
}

$result = @(Run-Docker build -t 'example.test/image:dev' '.')
Assert-True ($result.Count -eq 1 -and $result[0] -eq 0) 'Successful Docker output must not become a failure status.'
Assert-True ($ErrorActionPreference -eq 'Stop') 'Run-Docker must restore error handling.'

$script:dockerExitCode = 17
$result = @(Run-Docker compose up -d)
Assert-True ($result.Count -eq 1 -and $result[0] -eq 17) 'Failed Docker commands must retain their exit status.'

$script:dockerExitCode = 0
Assert-True (Test-Docker) 'Reachable Docker must be detected despite stdout.'
$script:dockerExitCode = 1
Assert-True (-not (Test-Docker)) 'Docker failure must not be hidden.'

$script:dockerExitCode = 0
$reference = 'registry.test/name:tag&literal'
Assert-True (Image-Exists $reference) 'Image success must be detected.'
$lastCall = $script:dockerCalls[-1]
Assert-True ($lastCall.Count -eq 4 -and $lastCall[0] -eq 'image' -and $lastCall[1] -eq 'inspect' -and $lastCall[2] -eq '--' -and $lastCall[3] -eq $reference) 'Image references must remain one literal argument.'
$script:dockerExitCode = 1
Assert-True (-not (Image-Exists $reference)) 'Missing images must be reported.'

Write-Output "$script:checks Windows Docker boundary checks passed."
