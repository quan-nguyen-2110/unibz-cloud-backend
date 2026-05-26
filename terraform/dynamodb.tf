resource "aws_dynamodb_table" "users" {
  name         = "${var.project_name}-users"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"

  attribute {
    name = "userId"
    type = "S"
  }
}

resource "aws_dynamodb_table" "plans" {
  name         = "${var.project_name}-plans"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "planId"
  range_key    = "createdAt"

  attribute {
    name = "planId"
    type = "S"
  }

  attribute {
    name = "createdAt"
    type = "S"
  }

  attribute {
    name = "status"
    type = "S"
  }

  global_secondary_index {
    name            = "StatusIndex"
    hash_key        = "status"
    range_key       = "createdAt"
    projection_type = "ALL"
  }

  # TTL disabled — plans are retained until explicitly cancelled/removed.
  ttl {
    attribute_name = "expiresAt"
    enabled        = false
  }
}

resource "aws_dynamodb_table" "tap_ins" {
  name         = "${var.project_name}-tap-ins"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "planId"
  range_key    = "userId"

  attribute {
    name = "planId"
    type = "S"
  }

  attribute {
    name = "userId"
    type = "S"
  }
}

resource "aws_dynamodb_table" "plan_photos" {
  name         = "${var.project_name}-plan-photos"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "planId"
  range_key    = "photoId"

  attribute {
    name = "planId"
    type = "S"
  }

  attribute {
    name = "photoId"
    type = "S"
  }
}

resource "aws_dynamodb_table" "notifications" {
  name         = "${var.project_name}-notifications"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "notificationId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "notificationId"
    type = "S"
  }
}

resource "aws_dynamodb_table" "friends" {
  name         = "${var.project_name}-friendships"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "friendId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "friendId"
    type = "S"
  }

  # Incoming friend requests: query by recipient (friendId = me), filter status = pending.
  global_secondary_index {
    name            = "FriendIndex"
    hash_key        = "friendId"
    projection_type = "ALL"
  }
}
