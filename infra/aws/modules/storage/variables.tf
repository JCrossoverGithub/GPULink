variable "availability_zone" {
  description = "Availability zone containing the GPULink host."
  type        = string
}

variable "instance_id" {
  description = "EC2 instance to which the PostgreSQL volume is attached."
  type        = string
}

variable "volume_size_gib" {
  description = "Size of the PostgreSQL gp3 data volume."
  type        = number
}
