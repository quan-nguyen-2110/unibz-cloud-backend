# Scale-out experiment: run k6 at fixed task counts 1, 2, 4 (≥5 repeats each).
# Produces JSON summaries under load-tests/results/scale-out/ for analyze_results.py.

param(
  [int[]]$TaskCounts = @(1, 2, 4),
  [int]$Repeats = 5,
  [ValidateSet('feed', 'notifications', 'healthz', 'full')]
  [string]$Scenario = 'feed',
  [string]$BaseUrl = 'http://squadup-alb-363579702.us-east-1.elb.amazonaws.com',
  [string]$Email = $env:EMAIL,
  [string]$Password = $env:PASSWORD,
  [int]$CooldownSec = 30
)

$ErrorActionPreference = 'Stop'
$scriptsDir = $PSScriptRoot
$resultsRoot = Join-Path (Split-Path $scriptsDir -Parent) 'results\scale-out'
New-Item -ItemType Directory -Path $resultsRoot -Force | Out-Null

$manifest = @{
  startedAt   = (Get-Date).ToUniversalTime().ToString('o')
  scenario    = $Scenario
  taskCounts  = $TaskCounts
  repeats     = $Repeats
  baseUrl     = $BaseUrl
  runs        = @()
}

foreach ($count in $TaskCounts) {
  Write-Host "`n========== Task count: $count ==========" -ForegroundColor Cyan
  & (Join-Path $scriptsDir 'set-ecs-count.ps1') -TaskCount $count
  Start-Sleep -Seconds $CooldownSec

  for ($i = 1; $i -le $Repeats; $i++) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $exportPath = Join-Path $resultsRoot "tasks${count}_run${i}_${stamp}.json"
    Write-Host "Run $i/$Repeats -> $exportPath"

    & (Join-Path $scriptsDir 'run-k6.ps1') `
      -Scenario $Scenario `
      -BaseUrl $BaseUrl `
      -Email $Email `
      -Password $Password `
      -SummaryExport $exportPath `
      -Quiet

    if ($LASTEXITCODE -ne 0) {
      Write-Warning "k6 exit code $LASTEXITCODE (thresholds may have failed - summary still exported)"
    }

    $manifest.runs += @{
      taskCount = $count
      runIndex  = $i
      summary   = $exportPath
      exitCode  = $LASTEXITCODE
    }
    Start-Sleep -Seconds 10
  }
}

Write-Host "`nRestoring autoscaling..."
& (Join-Path $scriptsDir 'set-ecs-count.ps1') -TaskCount 4 -RestoreAutoscaling

$manifest.endedAt = (Get-Date).ToUniversalTime().ToString('o')
$manifestPath = Join-Path $resultsRoot 'manifest.json'
$manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestPath -Encoding UTF8
Write-Host "Manifest: $manifestPath"
Write-Host 'Analyze: python load-tests/analyze/analyze_results.py --scale-out load-tests/results/scale-out'
