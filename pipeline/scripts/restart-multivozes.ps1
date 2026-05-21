param(
  [switch]$Build
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pipelineDir = Split-Path -Parent $scriptDir
$composeFile = Join-Path $pipelineDir "docker-compose.yml"

if (-not (Test-Path -LiteralPath $composeFile)) {
  Write-Error "Arquivo docker-compose não encontrado em: $composeFile"
  exit 1
}

$composeArgs = @("compose", "-f", $composeFile)
if ($Build) {
  & docker @composeArgs up -d --build multivozes
} else {
  & docker @composeArgs up -d multivozes
}

Write-Host "Aguardando healthcheck do multivozes..."
Start-Sleep -Seconds 4

for ($i = 0; $i -lt 20; $i++) {
  $status = docker inspect yt-pipeline-multivozes --format "{{.State.Health.Status}}" 2>$null
  if ($status -eq "healthy") {
    Write-Host "multivozes saudável."
    exit 0
  }
  Start-Sleep -Seconds 2
}

Write-Host "multivozes não ficou healthy a tempo. Logs recentes:"
docker logs --tail 120 yt-pipeline-multivozes
exit 1
