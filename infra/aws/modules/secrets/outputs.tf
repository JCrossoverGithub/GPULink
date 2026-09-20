output "postgres_auth_secret_name" {
  description = "Name of the PostgreSQL authentication secret."
  value       = aws_secretsmanager_secret.postgres_auth.name
}

output "postgres_auth_secret_arn" {
  description = "ARN of the PostgreSQL authentication secret."
  value       = aws_secretsmanager_secret.postgres_auth.arn
}
