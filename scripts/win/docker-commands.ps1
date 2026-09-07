# Native Docker command boundaries shared by the local Windows launcher.
# Keep stdout visible without mixing it into the returned exit status.
function Run-Docker {
  # A named DockerArgs parameter would capture Docker's abbreviated `-d` switch.
  $commandArgs = @($args)
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $dockerCommand = Get-Command docker -ErrorAction Stop
    & $dockerCommand @commandArgs | Out-Host
    return $LASTEXITCODE
  } finally { $ErrorActionPreference = $old }
}

function Test-Docker {
  try { $dockerCommand = Get-Command docker -ErrorAction Stop } catch { return $false }
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    & $dockerCommand info *> $null
    return ($LASTEXITCODE -eq 0)
  } finally { $ErrorActionPreference = $old }
}

function Image-Exists {
  param([string]$ref)
  try { $dockerCommand = Get-Command docker -ErrorAction Stop } catch { return $false }
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $inspectArgs = @('image', 'inspect', '--', $ref)
    & $dockerCommand @inspectArgs *> $null
    return ($LASTEXITCODE -eq 0)
  } finally { $ErrorActionPreference = $old }
}
