data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }

    actions = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "host" {
  name               = "gpulink-production-host"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json

  tags = {
    Name = "gpulink-production-host"
  }
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "host" {
  name = "gpulink-production-host"
  role = aws_iam_role.host.name

  depends_on = [
    aws_iam_role_policy_attachment.ssm,
  ]
}

data "aws_iam_policy_document" "postgres_backup" {
  statement {
    sid = "ListPostgresBackupBucket"

    actions = [
      "s3:GetBucketLocation",
      "s3:ListBucket",
      "s3:ListBucketMultipartUploads",
    ]

    resources = [
      var.postgres_backup_bucket_arn,
    ]
  }

  statement {
    sid = "ManagePostgresBackupObjects"

    actions = [
      "s3:AbortMultipartUpload",
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:ListMultipartUploadParts",
      "s3:PutObject",
    ]

    resources = [
      "${var.postgres_backup_bucket_arn}/*",
    ]
  }
}

resource "aws_iam_role_policy" "postgres_backup" {
  name   = "gpulink-postgres-backup"
  role   = aws_iam_role.host.id
  policy = data.aws_iam_policy_document.postgres_backup.json
}

data "aws_iam_policy_document" "postgres_auth_secret" {
  statement {
    sid = "ReadPostgresAuthenticationSecret"

    actions = [
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
    ]

    resources = [
      var.postgres_auth_secret_arn,
    ]
  }
}

resource "aws_iam_role_policy" "postgres_auth_secret" {
  name   = "gpulink-postgres-auth-secret"
  role   = aws_iam_role.host.id
  policy = data.aws_iam_policy_document.postgres_auth_secret.json
}

data "aws_iam_policy_document" "postgres_image_pull" {
  statement {
    sid = "GetEcrAuthorizationToken"

    actions = [
      "ecr:GetAuthorizationToken",
    ]

    resources = ["*"]
  }

  statement {
    sid = "PullPostgresRuntimeImage"

    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]

    resources = [
      var.postgres_image_repository_arn,
    ]
  }
}

resource "aws_iam_role_policy" "postgres_image_pull" {
  name   = "gpulink-postgres-image-pull"
  role   = aws_iam_role.host.id
  policy = data.aws_iam_policy_document.postgres_image_pull.json
}
