terraform {
  backend "s3" {
    # Deployment-local. Supply during terraform init via -backend-config.
    bucket       = ""
    key          = "bootstrap/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
