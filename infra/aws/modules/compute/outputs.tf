output "instance_id" {
  description = "EC2 instance ID of the GPULink host."
  value       = aws_instance.host.id
}

output "ami_id" {
  description = "Ubuntu 24.04 AMI used by the GPULink host."
  value       = data.aws_ami.ubuntu.id
}

output "private_ip" {
  description = "Private IPv4 address of the GPULink host."
  value       = aws_instance.host.private_ip
}

output "public_ip" {
  description = "Stable Elastic IPv4 address of the GPULink host."
  value       = aws_eip.host.public_ip
}

output "elastic_ip_allocation_id" {
  description = "Allocation ID of the GPULink host Elastic IP."
  value       = aws_eip.host.id
}
