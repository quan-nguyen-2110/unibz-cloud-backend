resource "aws_security_group" "ecs_tasks" {
  name        = "${var.project_name}-ecs-tasks-sg"
  description = "ECS tasks from ALB only"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${var.project_name}-api"
  retention_in_days = 14
}

locals {
  api_image = var.container_image != "" ? var.container_image : "${aws_ecr_repository.api.repository_url}:latest"
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.project_name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.ecs_cpu
  memory                   = var.ecs_memory
  execution_role_arn       = local.ecs_execution_role_arn
  task_role_arn            = local.ecs_task_role_arn

  container_definitions = jsonencode([{
    name  = "api"
    image = local.api_image
    portMappings = [{
      containerPort = 8080
      protocol      = "tcp"
    }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "8080" },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "COGNITO_USER_POOL_ID", value = aws_cognito_user_pool.main.id },
      { name = "COGNITO_CLIENT_ID", value = aws_cognito_user_pool_client.app.id },
      { name = "DYNAMO_USERS_TABLE", value = aws_dynamodb_table.users.name },
      { name = "DYNAMO_PLANS_TABLE", value = aws_dynamodb_table.plans.name },
      { name = "DYNAMO_TAPINS_TABLE", value = aws_dynamodb_table.tap_ins.name },
      { name = "DYNAMO_FRIENDS_TABLE", value = aws_dynamodb_table.friends.name },
      { name = "DYNAMO_PLAN_PHOTOS_TABLE", value = aws_dynamodb_table.plan_photos.name },
      { name = "DYNAMO_NOTIFICATIONS_TABLE", value = aws_dynamodb_table.notifications.name },
      { name = "S3_AUDIO_BUCKET", value = aws_s3_bucket.audio.bucket },
      { name = "ENABLE_WORKERS", value = "true" },
      { name = "VOICE_PARSER", value = var.voice_parser },
      { name = "VOICE_LLM_BASE_URL", value = var.voice_llm_base_url },
      { name = "VOICE_LLM_MODEL", value = var.voice_llm_model },
      { name = "VOICE_LLM_TIMEOUT_MS", value = tostring(var.voice_llm_timeout_ms) },
      { name = "VOICE_LLM_API_KEY", value = var.voice_llm_api_key },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "api"
      }
    }
    essential = true
  }])
}

resource "aws_ecs_service" "api" {
  name            = "${var.project_name}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.ecs_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8080
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.http]
}
