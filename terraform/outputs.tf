output "alb_dns_name" {
  description = "ALB DNS — use as API base URL (http until ACM attached)"
  value       = aws_lb.main.dns_name
}

output "api_base_url" {
  value = "http://${aws_lb.main.dns_name}"
}

output "ecr_repository_url" {
  value = aws_ecr_repository.api.repository_url
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.app.id
}

output "dynamodb_tables" {
  value = {
    users   = aws_dynamodb_table.users.name
    plans   = aws_dynamodb_table.plans.name
    tap_ins = aws_dynamodb_table.tap_ins.name
    friends = aws_dynamodb_table.friends.name
  }
}

output "s3_audio_bucket" {
  value = aws_s3_bucket.audio.bucket
}

output "ecs_execution_role_arn" {
  description = "ECS execution role (LabRole when use_lab_role=true)"
  value       = local.ecs_execution_role_arn
}

output "ecs_task_role_arn" {
  description = "ECS task role (LabRole when use_lab_role=true)"
  value       = local.ecs_task_role_arn
}

output "logs_bucket" {
  description = "S3 bucket holding ALB access logs and VPC flow logs"
  value       = aws_s3_bucket.logs.bucket
}

output "cloudwatch_dashboard_url" {
  description = "Console URL for the SquadUp CloudWatch dashboard"
  value       = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards:name=${aws_cloudwatch_dashboard.main.dashboard_name}"
}

output "alarms_sns_topic_arn" {
  value = aws_sns_topic.alarms.arn
}

output "lambda_functions" {
  description = "Event-driven Lambdas migrated off the ECS task"
  value = {
    plan_lifecycle_sweep = aws_lambda_function.plan_lifecycle_sweep.function_name
  }
}
