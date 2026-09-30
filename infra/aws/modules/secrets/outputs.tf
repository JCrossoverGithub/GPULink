output "postgres_auth_secret_name" {
  description = "Name of the PostgreSQL authentication secret."
  value       = aws_secretsmanager_secret.postgres_auth.name
}

output "postgres_auth_secret_arn" {
  description = "ARN of the PostgreSQL authentication secret."
  value       = aws_secretsmanager_secret.postgres_auth.arn
}

output "control_plane_auth_secret_name" {
  description = "Name of the GPULink control-plane authentication secret."
  value       = aws_secretsmanager_secret.control_plane_auth.name
}

output "control_plane_auth_secret_arn" {
  description = "ARN of the GPULink control-plane authentication secret."
  value       = aws_secretsmanager_secret.control_plane_auth.arn
}

output "control_plane_tls_secret_name" {
  description = "Name of the GPULink control-plane TLS secret."
  value       = aws_secretsmanager_secret.control_plane_tls.name
}

output "control_plane_tls_secret_arn" {
  description = "ARN of the GPULink control-plane TLS secret."
  value       = aws_secretsmanager_secret.control_plane_tls.arn
}
