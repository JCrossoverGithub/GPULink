module "networking" {
  source = "../../modules/networking"

  vpc_cidr           = var.vpc_cidr
  public_subnet_cidr = var.public_subnet_cidr
}

module "iam" {
  source = "../../modules/iam"

  postgres_backup_bucket_arn    = module.backup.bucket_arn
  postgres_auth_secret_arn      = module.secrets.postgres_auth_secret_arn
  postgres_image_repository_arn = module.registry.postgres_repository_arn
}

module "compute" {
  source = "../../modules/compute"

  subnet_id             = module.networking.public_subnet_id
  security_group_id     = module.networking.host_security_group_id
  instance_profile_name = module.iam.instance_profile_name

  instance_type        = var.instance_type
  root_volume_size_gib = var.root_volume_size_gib
}

module "storage" {
  source = "../../modules/storage"

  availability_zone = module.networking.availability_zone
  instance_id       = module.compute.instance_id
  volume_size_gib   = var.postgres_volume_size_gib
}

data "aws_caller_identity" "current" {}

locals {
  postgres_backup_bucket_name = "gpulink-production-postgres-backups-${data.aws_caller_identity.current.account_id}-${var.aws_region}"
}

module "backup" {
  source = "../../modules/backup"

  bucket_name = local.postgres_backup_bucket_name
}

module "secrets" {
  source = "../../modules/secrets"

  postgres_auth_secret_name = "gpulink/production/postgres-auth"
}

module "registry" {
  source = "../../modules/registry"

  postgres_repository_name = "gpulink/postgres-pgbackrest"
}
