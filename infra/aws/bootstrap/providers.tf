provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "GPULink"
      ManagedBy = "Terraform"
      Phase     = "4"
      Component = "InfrastructureBootstrap"
    }
  }
}
