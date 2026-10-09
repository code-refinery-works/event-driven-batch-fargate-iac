variable "aws_region" {
  description = "AWSリージョン"
  type        = string
  default     = "ap-northeast-1"
}

variable "project" {
  description = "プロジェクト識別子（リソース命名に使用）"
  type        = string
  default     = "evbatch"
}

variable "env" {
  description = "環境識別子（prd / stg / dev）"
  type        = string
  default     = "prd"
  validation {
    condition     = contains(["prd", "stg", "dev"], var.env)
    error_message = "env は prd / stg / dev のいずれかを指定してください。"
  }
}