# SquadUp load-test experiments

k6 scripts exercise the live ALB. Use the PowerShell harness for repeatable scale-out, statistical, and resilience studies.

## Prerequisites

```powershell
# From repo root
. .\aws-credential\activate.ps1
# k6: https://grafana.com/docs/k6/latest/set-up/install-k6/
# Python 3 (optional charts): pip install -r load-tests/analyze/requirements.txt
```

Set credentials for authenticated scenarios:

```powershell
$env:EMAIL = "you@example.com"
$env:PASSWORD = "..."
```

## Apply infrastructure (scale-out + autoscaling)

```powershell
cd squadUp-backend\terraform
terraform plan   # desired_count=4, autoscaling 1–4 tasks, CPU + ALB RPS targets
terraform apply
```

## Single scenario

```powershell
.\squadUp-backend\load-tests\scripts\run-k6.ps1 -Scenario feed -Email $env:EMAIL -Password $env:PASSWORD
```

## 1. Scale-out experiment (latency/throughput vs task count)

Pins ECS to 1, 2, then 4 tasks (autoscaling suspended), runs `feed` **5×** per level, exports JSON summaries.

```powershell
.\squadUp-backend\load-tests\scripts\run-scale-experiment.ps1 `
  -Scenario feed -Repeats 5 -TaskCounts 1,2,4 `
  -Email $env:EMAIL -Password $env:PASSWORD
```

```powershell
python squadUp-backend\load-tests\analyze\analyze_results.py --scale-out squadUp-backend\load-tests\results\scale-out
```

Outputs: `scale_out_summary.csv`, `scale_out_report.md`, optional `scale_out_charts.png`.

## 2. Statistical rigour (≥5 repeats, CI + t-tests)

```powershell
.\squadUp-backend\load-tests\scripts\run-statistical-battery.ps1 `
  -Repeats 5 -Scenarios feed,notifications,healthz `
  -Email $env:EMAIL -Password $env:PASSWORD
```

```powershell
python squadUp-backend\load-tests\analyze\analyze_results.py --statistical squadUp-backend\load-tests\results\statistical
```

Welch t-test compares **feed vs notifications** p95 across runs (α = 0.05).

## 3. Resilience experiment (task kill mid-load)

Requires **≥2 tasks**. Starts sustained k6 load, stops one ECS task at ~90 s, polls ALB `UnHealthyHostCount` for recovery time. ECS deployment circuit breaker replaces the task.

```powershell
.\squadUp-backend\load-tests\scripts\run-resilience-experiment.ps1 `
  -MinTasks 2 -KillAfterSec 90 `
  -Email $env:EMAIL -Password $env:PASSWORD
```

```powershell
python squadUp-backend\load-tests\analyze\analyze_results.py --resilience squadUp-backend\load-tests\results\resilience
```

## Results layout

```
load-tests/results/
  scale-out/       tasks{N}_run{i}_*.json, manifest.json
  statistical/     {scenario}_run{i}_*.json, manifest.json
  resilience/      resilience_*_report.json, *_events.jsonl
```

Add `results/` to `.gitignore` if exporting large JSON locally (summaries only are needed for the report).
