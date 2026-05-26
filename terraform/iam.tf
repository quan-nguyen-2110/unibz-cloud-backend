# ECS IAM: custom roles (full accounts) or LabRole (AWS Academy Learner Lab).
# Learner Lab blocks iam:CreateRole — set use_lab_role = true in dev.tfvars.

data "aws_iam_role" "lab" {
  count = var.use_lab_role ? 1 : 0
  name  = var.lab_role_name
}

resource "aws_iam_role" "ecs_execution" {
  count = var.use_lab_role ? 0 : 1
  name  = "${var.project_name}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  count      = var.use_lab_role ? 0 : 1
  role       = aws_iam_role.ecs_execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "ecs_task" {
  count = var.use_lab_role ? 0 : 1
  name  = "${var.project_name}-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "ecs_task" {
  count = var.use_lab_role ? 0 : 1
  name  = "${var.project_name}-ecs-task-policy"
  role  = aws_iam_role.ecs_task[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:TransactWriteItems",
          "dynamodb:BatchGetItem",
          "dynamodb:BatchWriteItem"
        ]
        Resource = [
          aws_dynamodb_table.users.arn,
          aws_dynamodb_table.plans.arn,
          "${aws_dynamodb_table.plans.arn}/index/*",
          aws_dynamodb_table.tap_ins.arn,
          aws_dynamodb_table.friends.arn,
          aws_dynamodb_table.plan_photos.arn,
          aws_dynamodb_table.notifications.arn
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:HeadObject"
        ]
        Resource = ["${aws_s3_bucket.audio.arn}/*"]
      },
      {
        Effect = "Allow"
        Action = [
          "transcribe:StartTranscriptionJob",
          "transcribe:GetTranscriptionJob",
          "bedrock:InvokeModel"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "cognito-idp:SignUp",
          "cognito-idp:InitiateAuth",
          "cognito-idp:ConfirmSignUp",
          "cognito-idp:ResendConfirmationCode",
          "cognito-idp:ForgotPassword",
          "cognito-idp:ConfirmForgotPassword"
        ]
        Resource = aws_cognito_user_pool.main.arn
      }
    ]
  })
}

locals {
  ecs_execution_role_arn = var.use_lab_role ? data.aws_iam_role.lab[0].arn : aws_iam_role.ecs_execution[0].arn
  ecs_task_role_arn      = var.use_lab_role ? data.aws_iam_role.lab[0].arn : aws_iam_role.ecs_task[0].arn
}
