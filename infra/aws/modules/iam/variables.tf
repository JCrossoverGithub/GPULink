variable "postgres_backup_bucket_arn" {
  description = "ARN of the S3 bucket used by pgBackRest."
  type        = string
}

variable "postgres_auth_secret_arn" {
  description = "ARN of the Secrets Manager secret containing PostgreSQL authentication material."
  type        = string
}
