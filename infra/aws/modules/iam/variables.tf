variable "postgres_backup_bucket_arn" {
  description = "ARN of the S3 bucket used by pgBackRest."
  type        = string
}

variable "postgres_auth_secret_arn" {
  description = "ARN of the Secrets Manager secret containing PostgreSQL authentication material."
  type        = string
}

variable "postgres_image_repository_arn" {
  description = "ARN of the ECR repository containing the GPULink PostgreSQL runtime image."
  type        = string
}

variable "control_plane_auth_secret_arn" {
  description = "ARN of the Secrets Manager secret containing GPULink control-plane authentication material."
  type        = string
}

variable "control_plane_image_repository_arn" {
  description = "ARN of the ECR repository containing the GPULink control-plane runtime image."
  type        = string
}
