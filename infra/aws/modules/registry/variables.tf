variable "postgres_repository_name" {
  description = "Name of the ECR repository containing the GPULink PostgreSQL runtime image."
  type        = string
}

variable "control_plane_repository_name" {
  description = "Name of the ECR repository containing the GPULink control-plane runtime image."
  type        = string
}
