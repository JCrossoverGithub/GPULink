provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "GPULink"
      ManagedBy   = "Terraform"
      Environment = "production"
      Phase       = "4"
    }
  }
}
