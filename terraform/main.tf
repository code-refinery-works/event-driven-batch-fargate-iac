terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  # backend "s3" { bucket = "your-tfstate-bucket", key = "batch/prd/terraform.tfstate", region = "ap-northeast-1", dynamodb_table = "tfstate-lock" }
}

provider "aws" {
  region = var.aws_region
  default_tags { tags = { Project = var.project, Env = var.env, ManagedBy = "Terraform" } }
}

# ── KMS ──────────────────────────────────────────────────────────────
resource "aws_kms_key" "main" {
  description             = "${var.project}-${var.env}-cmk"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "RootAdmin", Effect = "Allow", Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }, Action = "kms:*", Resource = "*" },
      { Sid = "SQS",  Effect = "Allow", Principal = { Service = "sqs.amazonaws.com" },              Action = ["kms:Decrypt", "kms:GenerateDataKey*"], Resource = "*" },
      { Sid = "Logs", Effect = "Allow", Principal = { Service = "logs.${var.aws_region}.amazonaws.com" }, Action = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey*", "kms:DescribeKey"], Resource = "*" }
    ]
  })
}
resource "aws_kms_alias" "main" { name = "alias/${var.project}-${var.env}"; target_key_id = aws_kms_key.main.key_id }

# ── VPC & Subnets ─────────────────────────────────────────────────────
resource "aws_vpc" "main" { cidr_block = "10.0.0.0/20"; enable_dns_hostnames = true; enable_dns_support = true }

resource "aws_subnet" "private" {
  for_each          = { a = { cidr = "10.0.1.0/24", az = "${var.aws_region}a" }, c = { cidr = "10.0.2.0/24", az = "${var.aws_region}c" } }
  vpc_id            = aws_vpc.main.id
  cidr_block        = each.value.cidr
  availability_zone = each.value.az
}

resource "aws_route_table" "private" { vpc_id = aws_vpc.main.id }
resource "aws_route_table_association" "private" {
  for_each       = aws_subnet.private
  subnet_id      = each.value.id
  route_table_id = aws_route_table.private.id
}

# ── Security Groups ───────────────────────────────────────────────────
resource "aws_security_group" "ecs" {
  name   = "${var.project}-${var.env}-ecs"
  vpc_id = aws_vpc.main.id
  egress { from_port = 443; to_port = 443; protocol = "tcp"; cidr_blocks = ["0.0.0.0/0"] }
}
resource "aws_security_group" "vpce" {
  name   = "${var.project}-${var.env}-vpce"
  vpc_id = aws_vpc.main.id
  ingress { from_port = 443; to_port = 443; protocol = "tcp"; security_groups = [aws_security_group.ecs.id] }
}

# ── VPC Endpoints ─────────────────────────────────────────────────────
resource "aws_vpc_endpoint" "s3" {
  vpc_id          = aws_vpc.main.id
  service_name    = "com.amazonaws.${var.aws_region}.s3"
  route_table_ids = [aws_route_table.private.id]
}

locals {
  interface_endpoints = toset(["ecr.api", "ecr.dkr", "logs", "sqs"])
}
resource "aws_vpc_endpoint" "interface" {
  for_each            = local.interface_endpoints
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [for s in aws_subnet.private : s.id]
  security_group_ids  = [aws_security_group.vpce.id]
  private_dns_enabled = true
}

# ── SQS (Main + DLQ) ─────────────────────────────────────────────────
resource "aws_sqs_queue" "dlq" {
  name                      = "${var.project}-${var.env}-dlq"
  kms_master_key_id         = aws_kms_key.main.arn
  message_retention_seconds = 1209600
}
resource "aws_sqs_queue" "main" {
  name                       = "${var.project}-${var.env}-queue"
  kms_master_key_id          = aws_kms_key.main.arn
  visibility_timeout_seconds = 300
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.dlq.arn, maxReceiveCount = 3 })
}
resource "aws_sqs_queue_policy" "main" {
  queue_url = aws_sqs_queue.main.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "events.amazonaws.com" }, Action = "sqs:SendMessage", Resource = aws_sqs_queue.main.arn, Condition = { ArnEquals = { "aws:SourceArn" = "arn:aws:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:rule/${var.project}-${var.env}-*" } } }]
  })
}

# ── ECR ───────────────────────────────────────────────────────────────
resource "aws_ecr_repository" "main" {
  name                 = "${var.project}-${var.env}-batch"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "KMS"; kms_key = aws_kms_key.main.arn }
}

# ── SSM Parameter Store (CDKへ疎結合連携) ────────────────────────────
locals {
  ssm_params = {
    vpc_id      = aws_vpc.main.id
    subnet_ids  = join(",", [for s in aws_subnet.private : s.id])
    queue_arn   = aws_sqs_queue.main.arn
    queue_url   = aws_sqs_queue.main.id
    dlq_arn     = aws_sqs_queue.dlq.arn
    kms_key_arn = aws_kms_key.main.arn
    ecr_repo    = aws_ecr_repository.main.repository_url
    ecs_sg_id   = aws_security_group.ecs.id
  }
}
resource "aws_ssm_parameter" "infra" {
  for_each = local.ssm_params
  name     = "/${var.project}/${var.env}/${each.key}"
  type     = "String"
  value    = each.value
}

data "aws_caller_identity" "current" {}