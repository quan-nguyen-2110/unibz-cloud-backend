# ECS Application Auto Scaling — target-tracking on CPU and ALB request rate.
# LabRole trust policy includes application-autoscaling.amazonaws.com (Learner Lab).

resource "aws_appautoscaling_target" "ecs" {
  count = var.ecs_autoscaling_enabled ? 1 : 0

  max_capacity       = var.ecs_autoscaling_max_capacity
  min_capacity       = var.ecs_autoscaling_min_capacity
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "ecs_cpu" {
  count = var.ecs_autoscaling_enabled ? 1 : 0

  name               = "${var.project_name}-ecs-cpu-target"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs[0].resource_id
  scalable_dimension = aws_appautoscaling_target.ecs[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs[0].service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = var.ecs_autoscaling_target_cpu
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

resource "aws_appautoscaling_policy" "ecs_alb_requests" {
  count = var.ecs_autoscaling_enabled ? 1 : 0

  name               = "${var.project_name}-ecs-alb-rps-target"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs[0].resource_id
  scalable_dimension = aws_appautoscaling_target.ecs[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs[0].service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.main.arn_suffix}/${aws_lb_target_group.api.arn_suffix}"
    }
    target_value       = var.ecs_autoscaling_target_request_count
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}
