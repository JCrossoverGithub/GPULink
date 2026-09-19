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

output "host_instance_profile_name" {
  description = "IAM instance profile used by the GPULink host."
  value       = module.iam.instance_profile_name
}

output "host_role_name" {
  description = "IAM role assumed by the GPULink host."
  value       = module.iam.role_name
}

output "host_instance_id" {
  description = "EC2 instance ID of the GPULink production host."
  value       = module.compute.instance_id
}

output "host_ami_id" {
  description = "Ubuntu AMI used by the GPULink production host."
  value       = module.compute.ami_id
}

output "host_private_ip" {
  description = "Private IPv4 address of the GPULink production host."
  value       = module.compute.private_ip
}

output "host_public_ip" {
  description = "Stable public IPv4 address of the GPULink production host."
  value       = module.compute.public_ip
}
