#!/usr/bin/env bash
# Build and push SquadUp API image to ECR, then trigger ECS rolling deploy.
#
# Usage (from squadUp-backend/):
#   chmod +x scripts/ecr-push.sh
#   ./scripts/ecr-push.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

AWS_REGION="${AWS_REGION:-us-east-1}"
APP_NAME="${APP_NAME:-squadup}"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${APP_NAME}-api"

echo "→ Logging in to ECR..."
aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo "→ Building Docker image..."
docker build \
  --platform linux/amd64 \
  -t "${APP_NAME}-api:latest" \
  -t "${ECR_REPO}:latest" \
  .

echo "→ Pushing to ECR..."
docker push "${ECR_REPO}:latest"

echo "→ Updating ECS service..."
aws ecs update-service \
  --cluster "${APP_NAME}-cluster" \
  --service "${APP_NAME}-api" \
  --force-new-deployment \
  --region "${AWS_REGION}"

echo "✓ Deploy triggered: https://console.aws.amazon.com/ecs/home?region=${AWS_REGION}"
