#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { BatchPlatformStack } from "../lib/stack";

const app = new cdk.App();

const project = app.node.tryGetContext("project") ?? "evbatch";
const env     = app.node.tryGetContext("env")     ?? "prd";
const region  = app.node.tryGetContext("region")  ?? "ap-northeast-1";
const account = process.env.CDK_DEFAULT_ACCOUNT!;

new BatchPlatformStack(app, `${project}-${env}-batch-platform`, {
  project,
  env: { account, region },
  appEnv: env,
  scheduleExpression: app.node.tryGetContext("schedule") ?? "cron(0 1 * * ? *)",
});