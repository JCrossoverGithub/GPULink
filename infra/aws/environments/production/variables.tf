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
