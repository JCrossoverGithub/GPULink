variable "vpc_cidr" {
  description = "CIDR block for the GPULink VPC."
  type        = string
}

variable "public_subnet_cidr" {
  description = "CIDR block for the GPULink public subnet."
  type        = string
}
