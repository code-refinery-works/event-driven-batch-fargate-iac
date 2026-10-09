import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ssm    from "aws-cdk-lib/aws-ssm";
import * as iam    from "aws-cdk-lib/aws-iam";
import * as ecs    from "aws-cdk-lib/aws-ecs";
import * as ec2    from "aws-cdk-lib/aws-ec2";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sqs    from "aws-cdk-lib/aws-sqs";
import * as cw     from "aws-cdk-lib/aws-cloudwatch";
import * as logs   from "aws-cdk-lib/aws-logs";
import * as kms    from "aws-cdk-lib/aws-kms";

interface Props extends cdk.StackProps {
  project: string;
  appEnv: string;
  scheduleExpression: string;
}

export class BatchPlatformStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const { project, appEnv } = props;
    const p = (key: string) => `/${project}/${appEnv}/${key}`;

    // SSM から Terraform 基盤値を取得
    const vpcId      = ssm.StringParameter.valueFromLookup(this, p("vpc_id"));
    const subnetIds  = ssm.StringParameter.valueFromLookup(this, p("subnet_ids")).split(",");
    const queueArn   = ssm.StringParameter.valueFromLookup(this, p("queue_arn"));
    const queueUrl   = ssm.StringParameter.valueFromLookup(this, p("queue_url"));
    const dlqArn     = ssm.StringParameter.valueFromLookup(this, p("dlq_arn"));
    const kmsKeyArn  = ssm.StringParameter.valueFromLookup(this, p("kms_key_arn"));
    const ecrRepo    = ssm.StringParameter.valueFromLookup(this, p("ecr_repo"));
    const ecsSgId    = ssm.StringParameter.valueFromLookup(this, p("ecs_sg_id"));

    // 既存リソース参照
    const vpc      = ec2.Vpc.fromLookup(this, "Vpc", { vpcId });
    const subnets  = subnetIds.map((id, i) => ec2.Subnet.fromSubnetId(this, `Subnet${i}`, id));
    const queue    = sqs.Queue.fromQueueArn(this, "Queue", queueArn);
    const dlq      = sqs.Queue.fromQueueArn(this, "Dlq", dlqArn);
    const cmk      = kms.Key.fromKeyArn(this, "Cmk", kmsKeyArn);
    const ecsSg    = ec2.SecurityGroup.fromSecurityGroupId(this, "EcsSg", ecsSgId);

    // CloudWatch Logs
    const logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName:  `/ecs/${project}-${appEnv}-batch`,
      retention:     logs.RetentionDays.THREE_MONTHS,
      encryptionKey: cmk,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // IAM Roles
    const execRole = new iam.Role(this, "ExecRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy")],
    });
    cmk.grantDecrypt(execRole);

    const taskRole = new iam.Role(this, "TaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    queue.grantConsumeMessages(taskRole);
    cmk.grantDecrypt(taskRole);
    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [logGroup.logGroupArn],
    }));

    // ECS Cluster + Task Definition
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      enableFargateCapacityProviders: true,
      clusterName: `${project}-${appEnv}`,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: 256, memoryLimitMiB: 512,
      executionRole: execRole, taskRole,
    });
    taskDef.addContainer("batch", {
      image:   ecs.ContainerImage.fromRegistry(ecrRepo),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "batch", logGroup }),
      environment: { QUEUE_URL: queueUrl, ENV: appEnv },
    });

    // EventBridge Rule → SQS
    const rule = new events.Rule(this, "ScheduleRule", {
      ruleName:    `${project}-${appEnv}-schedule`,
      schedule:    events.Schedule.expression(props.scheduleExpression),
      description: "Batch trigger schedule",
    });
    rule.addTarget(new targets.SqsQueue(queue, {
      message: events.RuleTargetInput.fromObject({ source: "scheduler", project, env: appEnv }),
    }));

    // EventBridge Pipe: SQS → ECS RunTask
    const pipeRole = new iam.Role(this, "PipeRole", {
      assumedBy: new iam.ServicePrincipal("pipes.amazonaws.com"),
    });
    queue.grantConsumeMessages(pipeRole);
    cmk.grantDecrypt(pipeRole);
    pipeRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["ecs:RunTask", "iam:PassRole"],
      resources: [taskDef.taskDefinitionArn, execRole.roleArn, taskRole.roleArn],
    }));

    new cdk.CfnResource(this, "Pipe", {
      type: "AWS::Pipes::Pipe",
      properties: {
        Name:       `${project}-${appEnv}-sqs-to-ecs`,
        RoleArn:    pipeRole.roleArn,
        Source:     queueArn,
        SourceParameters: { SqsQueueParameters: { BatchSize: 1 } },
        Target:     cluster.clusterArn,
        TargetParameters: {
          EcsTaskParameters: {
            TaskDefinitionArn:    taskDef.taskDefinitionArn,
            LaunchType:           "FARGATE",
            TaskCount:            1,
            NetworkConfiguration: {
              AwsvpcConfiguration: {
                AssignPublicIp: "DISABLED",
                Subnets:        subnets.map(s => s.subnetId),
                SecurityGroups: [ecsSg.securityGroupId],
              },
            },
            CapacityProviderStrategy: [
              { CapacityProvider: "FARGATE_SPOT",   Weight: 7, Base: 0 },
              { CapacityProvider: "FARGATE",        Weight: 3, Base: 1 },
            ],
          },
        },
      },
    });

    // CloudWatch Alarms
    new cw.Alarm(this, "DlqAlarm", {
      alarmName:          `${project}-${appEnv}-dlq-visible`,
      alarmDescription:   "DLQにメッセージが滞留しています",
      metric:             dlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) }),
      threshold:          0,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods:  1,
      treatMissingData:   cw.TreatMissingData.NOT_BREACHING,
    });

    // Outputs
    new cdk.CfnOutput(this, "ClusterArn",    { value: cluster.clusterArn });
    new cdk.CfnOutput(this, "TaskDefArn",    { value: taskDef.taskDefinitionArn });
    new cdk.CfnOutput(this, "LogGroupName",  { value: logGroup.logGroupName });
  }
}