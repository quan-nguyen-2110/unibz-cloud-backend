# Resilience experiment: sustained k6 load + kill one ECS task mid-run.
# Measures ALB unhealthy-host recovery via CloudWatch and k6 error/latency summary.

param(
  [int]$KillAfterSec = 90,
  [string]$BaseUrl = 'http://squadup-alb-363579702.us-east-1.elb.amazonaws.com',
  [string]$Email = $env:EMAIL,
  [string]$Password = $env:PASSWORD,
  [string]$Cluster = $env:ECS_CLUSTER,
  [string]$Service = $env:ECS_SERVICE,
  [string]$Region = $env:AWS_REGION,
  [int]$MinTasks = 2
)

$ErrorActionPreference = 'Stop'
$scriptsDir = $PSScriptRoot
$resultsRoot = Join-Path (Split-Path $scriptsDir -Parent) 'results\resilience'
New-Item -ItemType Directory -Path $resultsRoot -Force | Out-Null

function Get-TerraformOutput {
  param([string]$Name)
  $terraformDir = Resolve-Path (Join-Path $scriptsDir '..\..\terraform')
  Push-Location $terraformDir
  try { return (terraform output -raw $Name 2>$null) } finally { Pop-Location }
}

if (-not $Cluster) { $Cluster = Get-TerraformOutput 'ecs_cluster_name' }
if (-not $Service) { $Service = Get-TerraformOutput 'ecs_service_name' }
if (-not $Region) { $Region = 'us-east-1' }

$albSuffix = Get-TerraformOutput 'alb_arn_suffix'
$tgSuffix = Get-TerraformOutput 'target_group_arn_suffix'

Write-Host "Ensuring at least $MinTasks tasks for failover test..."
& (Join-Path $scriptsDir 'set-ecs-count.ps1') -TaskCount $MinTasks

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$summaryPath = Join-Path $resultsRoot "resilience_${stamp}.json"
$eventLogPath = Join-Path $resultsRoot "resilience_${stamp}_events.jsonl"

Write-Host "Starting k6 resilience load (background)..."
$k6Job = Start-Job -ScriptBlock {
  param($Script, $BaseUrl, $Email, $Password, $Summary)
  $env:BASE_URL = $BaseUrl
  $env:EMAIL = $Email
  $env:PASSWORD = $Password
  & $Script -Scenario resilience -BaseUrl $BaseUrl -Email $Email -Password $Password -SummaryExport $Summary -Quiet
} -ArgumentList (Join-Path $scriptsDir 'run-k6.ps1'), $BaseUrl, $Email, $Password, $summaryPath

$events = [System.Collections.Generic.List[object]]::new()
function Add-Event($type, $detail) {
  $evt = @{ ts = (Get-Date).ToUniversalTime().ToString('o'); type = $type; detail = $detail }
  $events.Add($evt) | Out-Null
  ($evt | ConvertTo-Json -Compress) | Add-Content -Path $eventLogPath
  Write-Host "[$($evt.ts)] $type : $detail"
}

Add-Event 'load_start' @{ killAfterSec = $KillAfterSec; summary = $summaryPath }

Write-Host "Waiting ${KillAfterSec}s before task kill..."
Start-Sleep -Seconds $KillAfterSec

$tasks = aws ecs list-tasks `
  --cluster $Cluster `
  --service-name $Service `
  --desired-status RUNNING `
  --region $Region `
  --query 'taskArns' `
  --output json | ConvertFrom-Json

if ($tasks.Count -lt 1) {
  throw 'No running ECS tasks found to kill.'
}

$victim = $tasks | Get-Random
Add-Event 'task_kill' @{ taskArn = $victim; runningBefore = $tasks.Count }

$killStart = Get-Date
aws ecs stop-task --cluster $Cluster --task $victim --reason 'resilience-experiment' --region $Region --no-cli-pager | Out-Null
Add-Event 'stop_task_sent' @{ taskArn = $victim }

# Poll ALB unhealthy host count until back to 0 (or timeout).
$pollDeadline = (Get-Date).AddMinutes(5)
$recoveredAt = $null
do {
  Start-Sleep -Seconds 5
  $end = Get-Date
  $start = $end.AddMinutes(-2)
  $stats = aws cloudwatch get-metric-statistics `
    --namespace AWS/ApplicationELB `
    --metric-name UnHealthyHostCount `
    --dimensions "Name=LoadBalancer,Value=$albSuffix" "Name=TargetGroup,Value=$tgSuffix" `
    --start-time $start.ToUniversalTime().ToString('o') `
    --end-time $end.ToUniversalTime().ToString('o') `
    --period 60 `
    --statistics Maximum `
    --region $Region `
    --output json | ConvertFrom-Json

  $latest = ($stats.Datapoints | Sort-Object Timestamp -Descending | Select-Object -First 1)
  $unhealthy = if ($latest) { [double]$latest.Maximum } else { $null }
  Add-Event 'alb_unhealthy_poll' @{ unhealthy = $unhealthy }

  if ($null -ne $unhealthy -and $unhealthy -eq 0 -and -not $recoveredAt) {
    $recoveredAt = Get-Date
  }
} while (-not $recoveredAt -and (Get-Date) -lt $pollDeadline)

$recoverySec = if ($recoveredAt) { [math]::Round(($recoveredAt - $killStart).TotalSeconds, 1) } else { $null }
Add-Event 'recovery' @{ recoverySec = $recoverySec; circuitBreaker = 'enabled with rollback' }

Write-Host "Waiting for k6 to finish..."
Wait-Job $k6Job | Out-Null
$k6Exit = (Receive-Job $k6Job).Count
Remove-Job $k6Job

# ECS should replace the killed task (circuit breaker + desired count).
$afterTasks = aws ecs list-tasks `
  --cluster $Cluster `
  --service-name $Service `
  --desired-status RUNNING `
  --region $Region `
  --query 'length(taskArns)' `
  --output text
Add-Event 'load_end' @{ k6Exit = $LASTEXITCODE; runningTasksAfter = [int]$afterTasks }

& (Join-Path $scriptsDir 'set-ecs-count.ps1') -TaskCount 4 -RestoreAutoscaling

$report = @{
  startedAt    = $events[0].ts
  killAfterSec = $KillAfterSec
  recoverySec  = $recoverySec
  summaryPath  = $summaryPath
  eventLog     = $eventLogPath
  events       = $events
}
$reportPath = Join-Path $resultsRoot "resilience_${stamp}_report.json"
$report | ConvertTo-Json -Depth 8 | Set-Content -Path $reportPath -Encoding UTF8

Write-Host "`nResilience report: $reportPath"
if ($recoverySec) {
  Write-Host "ALB unhealthy -> healthy recovery: ${recoverySec}s" -ForegroundColor Green
} else {
  Write-Warning 'Recovery time not observed within 5 min (check CloudWatch dashboard).'
}
Write-Host 'Analyze: python load-tests/analyze/analyze_results.py --resilience load-tests/results/resilience'
