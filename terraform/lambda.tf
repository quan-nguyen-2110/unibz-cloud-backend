# ---------------------------------------------------------------------------
# Event-driven Lambdas: offload async work from the long-running ECS task.
#
#   - plan-lifecycle-sweep : EventBridge hourly schedule       -> active/locked
#                            -> ongoing (within duration) -> completed
#
# Handler source lives in squadUp-backend/lambdas/<fn>/. Node 20 ships the
# @aws-sdk/* clients, so each function packages to a zip of just its index.js.
#
# Learner Lab note: iam:CreateRole is blocked when use_lab_role = true, so the
# functions assume the shared LabRole (same pattern as ECS in iam.tf). A
# dedicated least-privilege role is created only for full AWS accounts.
# ---------------------------------------------------------------------------

locals {
  lambda_root     = "${path.module}/../lambdas"
  lambda_role_arn = var.use_lab_role ? data.aws_iam_role.lab[0].arn : aws_iam_role.lambda_exec[0].arn

  lambda_log_groups = toset([
    "plan-lifecycle-sweep",
  ])
}

# --- IAM (full accounts only; Learner Lab reuses LabRole) -------------------

resource "aws_iam_role" "lambda_exec" {
  count = var.use_lab_role ? 0 : 1
  name  = "${var.project_name}-lambda-exec"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "lambda_exec" {
  count = var.use_lab_role ? 0 : 1
  name  = "${var.project_name}-lambda-policy"
  role  = aws_iam_role.lambda_exec[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect = "Allow"
        Action = ["dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"]
        Resource = [
          aws_dynamodb_table.plans.arn,
          "${aws_dynamodb_table.plans.arn}/index/*",
          aws_dynamodb_table.notifications.arn,
        ]
      },
    ]
  })
}

# --- Log groups (explicit so retention matches the API) ---------------------

resource "aws_cloudwatch_log_group" "lambda" {
  for_each          = local.lambda_log_groups
  name              = "/aws/lambda/${var.project_name}-${each.key}"
  retention_in_days = 14
}

# --- Packaging --------------------------------------------------------------

data "archive_file" "plan_lifecycle_sweep" {
  type        = "zip"
  source_dir  = "${local.lambda_root}/plan-lifecycle-sweep"
  output_path = "${path.module}/build/plan-lifecycle-sweep.zip"
}

# --- Functions --------------------------------------------------------------

resource "aws_lambda_function" "plan_lifecycle_sweep" {
  function_name    = "${var.project_name}-plan-lifecycle-sweep"
  role             = local.lambda_role_arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.plan_lifecycle_sweep.output_path
  source_code_hash = data.archive_file.plan_lifecycle_sweep.output_base64sha256
  timeout          = 60
  memory_size      = 256

  environment {
    variables = {
      DYNAMO_PLANS_TABLE = aws_dynamodb_table.plans.name
      PLANS_STATUS_INDEX = "StatusIndex"
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}

# --- EventBridge hourly schedule for the plan lifecycle sweep ---------------

resource "aws_cloudwatch_event_rule" "plan_lifecycle_sweep" {
  name                = "${var.project_name}-plan-lifecycle-sweep"
  description         = "Hourly: advance plans active/locked -> ongoing -> completed by start time + duration"
  schedule_expression = "rate(1 hour)"
}

resource "aws_cloudwatch_event_target" "plan_lifecycle_sweep" {
  rule      = aws_cloudwatch_event_rule.plan_lifecycle_sweep.name
  target_id = "plan-lifecycle-sweep-lambda"
  arn       = aws_lambda_function.plan_lifecycle_sweep.arn
}

resource "aws_lambda_permission" "events_plan_lifecycle_sweep" {
  statement_id  = "AllowEventBridgeInvokePlanLifecycleSweep"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.plan_lifecycle_sweep.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.plan_lifecycle_sweep.arn
}
