resource "aws_cognito_user_pool" "main" {
  name = "${var.project_name}-users"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
    require_uppercase = true
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
  }

  schema {
    name                = "display_name"
    attribute_data_type = "String"
    mutable             = true
    string_attribute_constraints {
      min_length = 1
      max_length = 50
    }
  }

  # Cognito forbids changing schema after pool creation; ignore provider drift.
  lifecycle {
    ignore_changes = [schema]
  }
}

resource "aws_cognito_user_pool_client" "app" {
  name         = "${var.project_name}-app-client"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret                      = false
  explicit_auth_flows                  = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"]
  supported_identity_providers         = ["COGNITO"]
  prevent_user_existence_errors        = "ENABLED"
  refresh_token_validity               = 30
  access_token_validity                = 1
  id_token_validity                    = 1
  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  callback_urls = var.cognito_callback_urls
  logout_urls   = var.cognito_logout_urls
}
