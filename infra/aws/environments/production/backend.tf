terraform {
  backend "s3" {
    bucket       = "gpulink-terraform-state-790072401452-us-east-1"
    key          = "environments/production/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
