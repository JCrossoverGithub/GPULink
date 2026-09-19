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
