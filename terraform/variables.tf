variable "aws_region" {
  type        = string
  description = "AWS region (must match existing SquadUp resources — us-east-1)"
  default     = "us-east-1"
}

variable "project_name" {
  type        = string
  description = "Resource name prefix"
  default     = "squadup"
}

variable "environment" {
  type        = string
  description = "Environment tag (dev, prod)"
  default     = "dev"
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "container_image" {
  type        = string
  description = "ECR image URI (tag or digest) for API task"
  default     = ""
}

variable "ecs_cpu" {
  type    = number
  default = 512
}

variable "ecs_memory" {
  type    = number
  default = 1024
}

variable "ecs_desired_count" {
  type    = number
  default = 1
}

variable "cognito_callback_urls" {
  type    = list(string)
  default = ["http://localhost:3000/callback"]
}

variable "cognito_logout_urls" {
  type    = list(string)
  default = ["http://localhost:3000/"]
}

# AWS Academy Learner Lab: students cannot create IAM roles — reuse LabRole for ECS.
variable "use_lab_role" {
  type        = bool
  description = "When true, ECS uses existing LabRole instead of creating squadup-ecs-* roles"
  default     = true
}

variable "lab_role_name" {
  type        = string
  description = "Pre-provisioned lab role name (usually LabRole)"
  default     = "LabRole"
}

# Voice plan generation (OpenRouter). Set voice_llm_api_key in secrets.auto.tfvars (gitignored).
variable "voice_parser" {
  type        = string
  description = "AI provider order: external (OpenRouter) or bedrock"
  default     = "external"
}

variable "voice_llm_base_url" {
  type    = string
  default = "https://openrouter.ai/api/v1"
}

variable "voice_llm_model" {
  type    = string
  default = "google/gemini-2.5-flash"
}

variable "voice_llm_timeout_ms" {
  type    = number
  default = 15000
}

variable "voice_llm_api_key" {
  type        = string
  description = "OpenRouter API key (required when voice_parser=external)"
  sensitive   = true
  default     = "sk-or-v1-...."
}
