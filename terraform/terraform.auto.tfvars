# Auto-loaded on every terraform plan/apply (same as dev.tfvars).
aws_region        = "us-east-1"
project_name      = "squadup"
environment       = "dev"
ecs_desired_count = 4

# Target-tracking autoscaling: CPU 60 % + ALB 1000 req/target/min, range 1–4 tasks.
ecs_autoscaling_enabled              = true
ecs_autoscaling_min_capacity         = 1
ecs_autoscaling_max_capacity         = 4
ecs_autoscaling_target_cpu           = 60
ecs_autoscaling_target_request_count = 1000
use_lab_role      = true
lab_role_name     = "LabRole"
