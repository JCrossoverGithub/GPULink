variable "ami_id" {
  description = "Immutable, region-specific AMI ID for the GPULink host."
  type        = string

  validation {
    condition     = can(regex("^ami-[0-9a-f]+$", var.ami_id))
    error_message = "ami_id must be an AWS AMI ID such as ami-0123456789abcdef0."
  }
}

variable "subnet_id" {
  description = "Subnet in which to launch the GPULink host."
  type        = string
}

variable "security_group_id" {
  description = "Security group attached to the GPULink host."
  type        = string
}

variable "instance_profile_name" {
  description = "IAM instance profile attached to the GPULink host."
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type for the GPULink host."
  type        = string
}

variable "root_volume_size_gib" {
  description = "Size of the GPULink host root gp3 volume."
  type        = number
}
