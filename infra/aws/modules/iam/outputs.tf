output "instance_profile_name" {
  description = "IAM instance profile for the GPULink EC2 host."
  value       = aws_iam_instance_profile.host.name
}

output "role_name" {
  description = "IAM role assumed by the GPULink EC2 host."
  value       = aws_iam_role.host.name
}

output "role_arn" {
  description = "ARN of the GPULink EC2 host IAM role."
  value       = aws_iam_role.host.arn
}
