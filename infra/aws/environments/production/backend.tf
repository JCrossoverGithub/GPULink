terraform {
  backend "s3" {
    # Deployment-local. Supply during terraform init via -backend-config.
    bucket       = ""
    key          = "environments/production/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
