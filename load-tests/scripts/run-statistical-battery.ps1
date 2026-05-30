# Statistical battery: repeat each scenario ≥5× for confidence intervals and t-tests.

param(
  [int]$Repeats = 5,
  [string[]]$Scenarios = @('feed', 'notifications', 'healthz'),
  [string]$BaseUrl = 'http://squadup-alb-363579702.us-east-1.elb.amazonaws.com',
  [string]$Email = $env:EMAIL,
  [string]$Password = $env:PASSWORD,
  [int]$CooldownSec = 20
)

$ErrorActionPreference = 'Stop'
$scriptsDir = $PSScriptRoot
$resultsRoot = Join-Path (Split-Path $scriptsDir -Parent) 'results\statistical'
New-Item -ItemType Directory -Path $resultsRoot -Force | Out-Null

$manifest = @{
  startedAt  = (Get-Date).ToUniversalTime().ToString('o')
  repeats    = $Repeats
  scenarios  = $Scenarios
  baseUrl    = $BaseUrl
  runs       = @()
}

foreach ($scenario in $Scenarios) {
  Write-Host "`n========== Scenario: $scenario ==========" -ForegroundColor Cyan
  for ($i = 1; $i -le $Repeats; $i++) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $exportPath = Join-Path $resultsRoot "${scenario}_run${i}_${stamp}.json"
    Write-Host "Run $i/$Repeats -> $exportPath"

    $k6Args = @{
      Scenario      = $scenario
      BaseUrl       = $BaseUrl
      SummaryExport = $exportPath
      Quiet         = $true
    }
    if ($scenario -ne 'healthz') {
      $k6Args.Email = $Email
      $k6Args.Password = $Password
    }

    & (Join-Path $scriptsDir 'run-k6.ps1') @k6Args
    $manifest.runs += @{
      scenario  = $scenario
      runIndex  = $i
      summary   = $exportPath
      exitCode  = $LASTEXITCODE
    }
    Start-Sleep -Seconds $CooldownSec
  }
}

$manifest.endedAt = (Get-Date).ToUniversalTime().ToString('o')
$manifestPath = Join-Path $resultsRoot 'manifest.json'
$manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestPath -Encoding UTF8
Write-Host "Manifest: $manifestPath"
Write-Host 'Analyze: python load-tests/analyze/analyze_results.py --statistical load-tests/results/statistical'
