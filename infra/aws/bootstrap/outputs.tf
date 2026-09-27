output "terraform_state_bucket" {
  description = "S3 bucket used for GPULink Terraform remote state."
  value       = aws_s3_bucket.terraform_state.id
}

output "terraform_state_region" {
  description = "AWS region containing the Terraform state bucket."
  value       = var.aws_region
}

output "aws_account_id" {
  description = "AWS account containing the GPULink infrastructure."
  value       = data.aws_caller_identity.current.account_id
}
