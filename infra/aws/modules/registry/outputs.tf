output "postgres_repository_name" {
  description = "Name of the GPULink PostgreSQL ECR repository."
  value       = aws_ecr_repository.postgres.name
}

output "postgres_repository_arn" {
  description = "ARN of the GPULink PostgreSQL ECR repository."
  value       = aws_ecr_repository.postgres.arn
}

output "postgres_repository_url" {
  description = "Registry URL of the GPULink PostgreSQL ECR repository."
  value       = aws_ecr_repository.postgres.repository_url
}
