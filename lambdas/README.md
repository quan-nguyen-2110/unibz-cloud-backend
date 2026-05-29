# SquadUp event-driven Lambdas

These functions move async work **out of the long-running ECS task** and into
event-driven AWS Lambda. They are provisioned by
[`../terraform/lambda.tf`](../terraform/lambda.tf) and packaged straight from the
folders here — the Node 20 Lambda runtime ships the `@aws-sdk/*` clients, so each
function is just an `index.js` with no `node_modules` to bundle.

| Function | Trigger | Replaces | What it does |
|----------|---------|----------|--------------|
| `plan-lifecycle-sweep` | EventBridge `rate(1 hour)` | `recap-sweep` / `workers/recapSweep.js` node-cron stub | Queries the Plans `StatusIndex` for live plans (`active`/`locked`/`ongoing`) and advances them by the clock: started but within `durationMinutes` → `ongoing`; duration elapsed (or no duration) → `completed`. Conditional update never clobbers a `cancelled` plan. |

## Why these

They are genuinely event-driven and were previously stubs or naive in-process
loops, so moving them does **not** touch the live request path or the in-memory
WebSocket feed hub (`hubs/feedHub.js`), which stays on ECS.

## IAM / Learner Lab

With `use_lab_role = true` (AWS Academy) the functions assume the shared
**LabRole**, matching the ECS pattern in `terraform/iam.tf`, because
`iam:CreateRole` is blocked. This requires LabRole's trust policy to allow
`lambda.amazonaws.com` (it does in the standard Learner Lab). For full AWS
accounts, Terraform creates a least-privilege `squadup-lambda-exec` role instead.

## Deploy

Code changes are applied via Terraform (the zip hash changes, forcing an update):

```bash
cd squadUp-backend/terraform
terraform apply
```

This is separate from the ECS image deploy (`scripts/ecr-push.sh`).
