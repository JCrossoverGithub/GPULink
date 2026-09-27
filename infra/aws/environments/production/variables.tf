variable "host_ami_id" {
  description = "Immutable, region-specific AMI ID for the GPULink production host. Supply through deployment-local configuration."
  type        = string

  validation {
    condition     = can(regex("^ami-[0-9a-f]+$", var.host_ami_id))
    error_message = "host_ami_id must be an AWS AMI ID such as ami-0123456789abcdef0."
  }
}

variable "aws_region" {
  description = "Primary AWS region for GPULink."
  type        = string
  default     = "us-east-1"
}

variable "vpc_cidr" {
  description = "CIDR block for the GPULink VPC."
  type        = string
  default     = "10.40.0.0/16"
}

variable "public_subnet_cidr" {
  description = "CIDR block for the initial GPULink public subnet."
  type        = string
  default     = "10.40.10.0/24"
}

variable "instance_type" {
  description = "EC2 instance type for the initial GPULink K3s host."
  type        = string
  default     = "t3.medium"
}

variable "root_volume_size_gib" {
  description = "Size of the replaceable EC2 root volume."
  type        = number
  default     = 20
}

variable "postgres_volume_size_gib" {
  description = "Size of the dedicated PostgreSQL data volume."
  type        = number
  default     = 20
}
