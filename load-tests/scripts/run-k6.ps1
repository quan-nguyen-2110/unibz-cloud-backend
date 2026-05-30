# Load-test experiment harness
# Run from repo root after: . .\aws-credential\activate.ps1

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('healthz', 'feed', 'notifications', 'recaps', 'full', 'resilience')]
  [string]$Scenario,

  [string]$BaseUrl = 'http://squadup-alb-363579702.us-east-1.elb.amazonaws.com',
  [string]$Email = $env:EMAIL,
  [string]$Password = $env:PASSWORD,
  [string]$Token = $env:TOKEN,
  [string]$DevUserId = $env:DEV_USER_ID,
  [string]$SummaryExport = '',
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$loadTestsDir = Split-Path $PSScriptRoot -Parent
$scriptPath = Join-Path $loadTestsDir "$Scenario.js"

if (-not (Test-Path $scriptPath)) {
  throw "Scenario script not found: $scriptPath"
}

if (-not (Get-Command k6 -ErrorAction SilentlyContinue)) {
  throw 'k6 not found on PATH. Install from https://grafana.com/docs/k6/latest/set-up/install-k6/'
}

$env:BASE_URL = $BaseUrl.TrimEnd('/')
if ($Email) { $env:EMAIL = $Email }
if ($Password) { $env:PASSWORD = $Password }
if ($Token) { $env:TOKEN = $Token }
if ($DevUserId) { $env:DEV_USER_ID = $DevUserId }

$k6Args = @('run')
if ($SummaryExport) {
  $exportDir = Split-Path $SummaryExport -Parent
  if ($exportDir -and -not (Test-Path $exportDir)) {
    New-Item -ItemType Directory -Path $exportDir -Force | Out-Null
  }
  $k6Args += @('--summary-export', $SummaryExport)
}
if ($Quiet) {
  $k6Args += '--quiet'
}
$k6Args += $scriptPath

Push-Location $loadTestsDir
try {
  & k6 @k6Args
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
