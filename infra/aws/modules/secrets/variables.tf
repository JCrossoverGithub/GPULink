variable "postgres_auth_secret_name" {
  description = "Name of the durable PostgreSQL authentication secret."
  type        = string
}

variable "control_plane_auth_secret_name" {
  description = "Name of the durable GPULink control-plane authentication secret."
  type        = string
}

variable "control_plane_tls_secret_name" {
  description = "Name of the Secrets Manager secret containing deployment-local GPULink control-plane TLS material."
  type        = string
}
