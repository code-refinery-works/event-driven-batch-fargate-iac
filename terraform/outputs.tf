output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.main.id
}

output "private_subnet_ids" {
  description = "プライベートサブネットID一覧"
  value       = [for s in aws_subnet.private : s.id]
}

output "sqs_queue_arn" {
  description = "メインSQSキュー ARN"
  value       = aws_sqs_queue.main.arn
}

output "sqs_dlq_arn" {
  description = "DLQ ARN"
  value       = aws_sqs_queue.dlq.arn
}

output "kms_key_arn" {
  description = "KMS CMK ARN"
  value       = aws_kms_key.main.arn
}

output "ecr_repository_url" {
  description = "ECRリポジトリURL"
  value       = aws_ecr_repository.main.repository_url
}

output "ecs_security_group_id" {
  description = "ECSタスク用セキュリティグループID"
  value       = aws_security_group.ecs.id
}

output "ssm_parameter_paths" {
  description = "SSM Parameter Storeに格納された基盤情報のキー一覧"
  value       = { for k, v in aws_ssm_parameter.infra : k => v.name }
}