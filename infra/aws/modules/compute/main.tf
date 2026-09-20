data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }
}

resource "aws_instance" "host" {
  ami           = data.aws_ami.ubuntu.id
  instance_type = var.instance_type

  subnet_id              = var.subnet_id
  vpc_security_group_ids = [var.security_group_id]

  iam_instance_profile = var.instance_profile_name

  # Public IPv4 reachability is provided exclusively by the
  # Terraform-managed Elastic IP associated below.

  # GPULink administration uses SSM rather than SSH.
  # No EC2 key pair is configured.
  monitoring = false

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gib
    encrypted             = true
    delete_on_termination = true

    tags = {
      Name = "gpulink-production-root"
    }
  }

  # Prevent surprise T3 Unlimited CPU-credit charges.
  credit_specification {
    cpu_credits = "standard"
  }

  user_data = <<-EOF
    #!/bin/bash
    set -euxo pipefail

    # Official Ubuntu AWS images normally include SSM Agent.
    # Start it if present; retry installation if an image ever lacks it.
    if ! snap list amazon-ssm-agent >/dev/null 2>&1; then
      for attempt in $(seq 1 30); do
        if snap install amazon-ssm-agent --classic; then
          break
        fi
        sleep 10
      done
    fi

    snap start amazon-ssm-agent || true
    systemctl enable snap.amazon-ssm-agent.amazon-ssm-agent.service || true
    systemctl restart snap.amazon-ssm-agent.amazon-ssm-agent.service || true
  EOF

  user_data_replace_on_change = true

  tags = {
    Name = "gpulink-production-host"
  }
}

resource "aws_eip" "host" {
  domain = "vpc"

  tags = {
    Name = "gpulink-production-host"
  }
}

resource "aws_eip_association" "host" {
  allocation_id = aws_eip.host.id
  instance_id   = aws_instance.host.id
}
