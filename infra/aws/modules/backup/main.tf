resource "aws_s3_bucket" "postgres_backup" {
  bucket = var.bucket_name

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name      = var.bucket_name
    Component = "PostgreSQL"
    Purpose   = "BackupAndWAL"
  }
}

resource "aws_s3_bucket_versioning" "postgres_backup" {
  bucket = aws_s3_bucket.postgres_backup.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "postgres_backup" {
  bucket = aws_s3_bucket.postgres_backup.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "postgres_backup" {
  bucket = aws_s3_bucket.postgres_backup.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "postgres_backup" {
  bucket = aws_s3_bucket.postgres_backup.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

data "aws_iam_policy_document" "postgres_backup" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = [
      "s3:*",
    ]

    resources = [
      aws_s3_bucket.postgres_backup.arn,
      "${aws_s3_bucket.postgres_backup.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "postgres_backup" {
  bucket = aws_s3_bucket.postgres_backup.id
  policy = data.aws_iam_policy_document.postgres_backup.json

  depends_on = [
    aws_s3_bucket_public_access_block.postgres_backup,
    aws_s3_bucket_ownership_controls.postgres_backup,
  ]
}

resource "aws_s3_bucket_lifecycle_configuration" "postgres_backup" {
  bucket = aws_s3_bucket.postgres_backup.id

  depends_on = [
    aws_s3_bucket_versioning.postgres_backup,
  ]

  rule {
    id     = "backup-version-hygiene"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }

    expiration {
      expired_object_delete_marker = true
    }
  }
}
