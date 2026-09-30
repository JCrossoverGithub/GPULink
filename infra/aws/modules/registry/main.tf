resource "aws_ecr_repository" "postgres" {
  name                 = var.postgres_repository_name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name      = var.postgres_repository_name
    Component = "PostgreSQL"
    Purpose   = "RuntimeImage"
  }
}

resource "aws_ecr_lifecycle_policy" "postgres" {
  repository = aws_ecr_repository.postgres.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Remove untagged images after 14 days"

        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 14
        }

        action = {
          type = "expire"
        }
      }
    ]
  })
}

resource "aws_ecr_repository" "control_plane" {
  name                 = var.control_plane_repository_name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name      = var.control_plane_repository_name
    Component = "ControlPlane"
    Purpose   = "RuntimeImage"
  }
}

resource "aws_ecr_lifecycle_policy" "control_plane" {
  repository = aws_ecr_repository.control_plane.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Remove untagged images after 14 days"

        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 14
        }

        action = {
          type = "expire"
        }
      }
    ]
  })
}
