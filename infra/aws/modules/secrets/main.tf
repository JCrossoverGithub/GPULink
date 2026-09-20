resource "aws_secretsmanager_secret" "postgres_auth" {
  name        = var.postgres_auth_secret_name
  description = "Durable authentication secret backing GPULink production PostgreSQL."

  # Allow recovery from an accidental deletion request.
  recovery_window_in_days = 30

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name      = var.postgres_auth_secret_name
    Component = "PostgreSQL"
    Purpose   = "Authentication"
  }
}
