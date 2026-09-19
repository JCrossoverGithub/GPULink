output "vpc_id" {
  description = "GPULink production VPC ID."
  value       = module.networking.vpc_id
}

output "public_subnet_id" {
  description = "GPULink production public subnet ID."
  value       = module.networking.public_subnet_id
}

output "host_security_group_id" {
  description = "Security group for the GPULink K3s host."
  value       = module.networking.host_security_group_id
}

output "availability_zone" {
  description = "Availability zone used by the initial GPULink host."
  value       = module.networking.availability_zone
}
