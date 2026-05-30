# Pin ECS service to a fixed task count for scale-out experiments.
# Temporarily suspends Application Auto Scaling so desired_count stays fixed.

param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 10)]
  [int]$TaskCount,

  [string]$Cluster = $env:ECS_CLUSTER,
  [string]$Service = $env:ECS_SERVICE,
  [string]$Region = $env:AWS_REGION,
  [int]$WaitTimeoutSec = 600,
  [switch]$RestoreAutoscaling
)

$ErrorActionPreference = 'Stop'

function Get-TerraformOutput {
  param([string]$Name)
  $terraformDir = Resolve-Path (Join-Path $PSScriptRoot '..\..\terraform')
  Push-Location $terraformDir
  try {
    return (terraform output -raw $Name 2>$null)
  } finally {
    Pop-Location
  }
}

if (-not $Cluster) { $Cluster = Get-TerraformOutput 'ecs_cluster_name' }
if (-not $Service) { $Service = Get-TerraformOutput 'ecs_service_name' }
if (-not $Region) { $Region = 'us-east-1' }

$resourceId = "service/$Cluster/$Service"

Write-Host "ECS: $Cluster / $Service -> desired_count=$TaskCount (region $Region)"

if ($RestoreAutoscaling) {
  Write-Host 'Resuming Application Auto Scaling...'
  aws application-autoscaling register-scalable-target `
    --service-namespace ecs `
    --resource-id $resourceId `
    --scalable-dimension ecs:service:DesiredCount `
    --min-capacity 1 `
    --max-capacity 4 `
    --region $Region | Out-Null
  Write-Host 'Autoscaling restored (min=1, max=4).'
  exit 0
}

Write-Host 'Suspending Application Auto Scaling (min=max=current pin)...'
aws application-autoscaling register-scalable-target `
  --service-namespace ecs `
  --resource-id $resourceId `
  --scalable-dimension ecs:service:DesiredCount `
  --min-capacity $TaskCount `
  --max-capacity $TaskCount `
  --region $Region | Out-Null

Write-Host "Updating desired_count to $TaskCount..."
aws ecs update-service `
  --cluster $Cluster `
  --service $Service `
  --desired-count $TaskCount `
  --region $Region `
  --no-cli-pager | Out-Null

Write-Host "Waiting for $TaskCount running task(s) (timeout ${WaitTimeoutSec}s)..."
$deadline = (Get-Date).AddSeconds($WaitTimeoutSec)
do {
  Start-Sleep -Seconds 10
  $desc = aws ecs describe-services `
    --cluster $Cluster `
    --services $Service `
    --region $Region `
    --query 'services[0].{running:runningCount,desired:desiredCount,deployments:deployments[0].rolloutState}' `
    --output json | ConvertFrom-Json

  Write-Host ("  running={0} desired={1} rollout={2}" -f $desc.running, $desc.desired, $desc.deployments)
  if ($desc.running -eq $TaskCount -and $desc.desired -eq $TaskCount -and $desc.deployments -eq 'COMPLETED') {
    Write-Host 'Steady state reached.'
    exit 0
  }
} while ((Get-Date) -lt $deadline)

throw "Timed out waiting for $TaskCount tasks."
