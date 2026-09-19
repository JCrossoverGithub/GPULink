module "networking" {
  source = "../../modules/networking"

  vpc_cidr           = var.vpc_cidr
  public_subnet_cidr = var.public_subnet_cidr
}

module "iam" {
  source = "../../modules/iam"
}

module "compute" {
  source = "../../modules/compute"

  subnet_id             = module.networking.public_subnet_id
  security_group_id     = module.networking.host_security_group_id
  instance_profile_name = module.iam.instance_profile_name

  instance_type        = var.instance_type
  root_volume_size_gib = var.root_volume_size_gib

  depends_on = [
    module.iam
  ]
}

module "storage" {
  source = "../../modules/storage"

  availability_zone = module.networking.availability_zone
  instance_id       = module.compute.instance_id
  volume_size_gib   = var.postgres_volume_size_gib
}
