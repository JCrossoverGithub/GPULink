output "bucket_name" {
  description = "S3 bucket used for PostgreSQL backups and WAL archives."
  value       = aws_s3_bucket.postgres_backup.bucket
}

output "bucket_arn" {
  description = "ARN of the PostgreSQL backup bucket."
  value       = aws_s3_bucket.postgres_backup.arn
}
