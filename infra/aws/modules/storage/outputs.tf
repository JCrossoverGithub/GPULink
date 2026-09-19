output "postgres_volume_id" {
  description = "EBS volume containing authoritative PostgreSQL data."
  value       = aws_ebs_volume.postgres.id
}

output "postgres_volume_size_gib" {
  description = "Size of the PostgreSQL EBS volume."
  value       = aws_ebs_volume.postgres.size
}

output "postgres_device_name" {
  description = "EC2 attachment device name requested for the PostgreSQL volume."
  value       = aws_volume_attachment.postgres.device_name
}
