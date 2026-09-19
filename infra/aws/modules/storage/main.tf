resource "aws_ebs_volume" "postgres" {
  availability_zone = var.availability_zone

  type       = "gp3"
  size       = var.volume_size_gib
  encrypted  = true
  iops       = 3000
  throughput = 125

  tags = {
    Name      = "gpulink-production-postgres"
    Component = "PostgreSQL"
    Purpose   = "AuthoritativeData"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_volume_attachment" "postgres" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.postgres.id
  instance_id = var.instance_id
}
