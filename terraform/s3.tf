resource "aws_s3_bucket" "audio" {
  bucket = "${var.project_name}-audio-${var.environment}-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "audio" {
  bucket                  = aws_s3_bucket.audio.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audio" {
  bucket = aws_s3_bucket.audio.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_caller_identity" "current" {}
