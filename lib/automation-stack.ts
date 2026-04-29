import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dlm from 'aws-cdk-lib/aws-dlm';

export interface AutomationStackProps extends cdk.StackProps {
  // Instance ID must be provided (CustomResource not available due to Lambda SCP)
  readonly instanceId: string;
}

export class AutomationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AutomationStackProps) {
    super(scope, id, props);

    // Add compliance tags
    cdk.Tags.of(this).add('Environment', 'production');
    cdk.Tags.of(this).add('Project', 'YouTrack');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Owner', 'a2i5giv');
    cdk.Tags.of(this).add('Purpose', 'Automation');

    // Use provided instance ID
    // Note: CustomResource lookup not available due to One.Cloud Lambda SCP restrictions
    // Instance ID must be updated manually if instance is replaced
    const instanceId = props.instanceId;

    // IAM role for Start Schedule
    const startRole = new iam.Role(this, 'YouTrackStartRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Role for EventBridge Scheduler to start YouTrack EC2 instance',
    });

    startRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:StartInstances'],
      resources: [
        `arn:aws:ec2:${this.region}:${this.account}:instance/*`,
      ],
      conditions: {
        'StringEquals': {
          'ec2:ResourceTag/Project': 'YouTrack',
        },
      },
    }));

    // IAM role for Stop Schedule
    const stopRole = new iam.Role(this, 'YouTrackStopRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Role for EventBridge Scheduler to stop YouTrack EC2 instance',
    });

    stopRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:StopInstances'],
      resources: [
        `arn:aws:ec2:${this.region}:${this.account}:instance/*`,
      ],
      conditions: {
        'StringEquals': {
          'ec2:ResourceTag/Project': 'YouTrack',
        },
      },
    }));

    // Start schedule: Monday-Friday at 07:00 UTC (7 AM WET / 8 AM WEST)
    const startSchedule = new scheduler.CfnSchedule(this, 'YouTrackStartSchedule', {
      name: 'youtrack-start-schedule',
      description: 'Start YouTrack EC2 instance Mon-Fri at 7 AM UTC',
      scheduleExpression: 'cron(0 7 ? * MON-FRI *)',
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: {
        mode: 'OFF',
      },
      target: {
        arn: 'arn:aws:scheduler:::aws-sdk:ec2:startInstances',
        roleArn: startRole.roleArn,
        input: JSON.stringify({
          InstanceIds: [instanceId],
        }),
        retryPolicy: {
          maximumRetryAttempts: 3,
          maximumEventAgeInSeconds: 300,
        },
      },
    });

    // Stop schedule: Monday-Friday at 19:00 UTC (7 PM WET / 8 PM WEST)
    const stopSchedule = new scheduler.CfnSchedule(this, 'YouTrackStopSchedule', {
      name: 'youtrack-stop-schedule',
      description: 'Stop YouTrack EC2 instance Mon-Fri at 7 PM UTC',
      scheduleExpression: 'cron(0 19 ? * MON-FRI *)',
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: {
        mode: 'OFF',
      },
      target: {
        arn: 'arn:aws:scheduler:::aws-sdk:ec2:stopInstances',
        roleArn: stopRole.roleArn,
        input: JSON.stringify({
          InstanceIds: [instanceId],
        }),
        retryPolicy: {
          maximumRetryAttempts: 3,
          maximumEventAgeInSeconds: 300,
        },
      },
    });

    // IAM role for DLM
    const dlmRole = new iam.Role(this, 'DlmLifecycleRole', {
      assumedBy: new iam.ServicePrincipal('dlm.amazonaws.com'),
      description: 'Role for DLM to manage EBS snapshots',
    });

    dlmRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ec2:CreateSnapshot',
        'ec2:CreateSnapshots',
        'ec2:DeleteSnapshot',
        'ec2:DescribeVolumes',
        'ec2:DescribeSnapshots',
        'ec2:DescribeInstances',
      ],
      resources: ['*'], // DLM requires * for describe operations
    }));

    dlmRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:CreateTags'],
      resources: [
        `arn:aws:ec2:${this.region}::snapshot/*`,
      ],
    }));

    // DLM Lifecycle Policy for weekly snapshots
    const dlmPolicy = new dlm.CfnLifecyclePolicy(this, 'YouTrackSnapshotPolicy', {
      description: 'Weekly EBS snapshots for YouTrack data volume',
      state: 'ENABLED',
      executionRoleArn: dlmRole.roleArn,
      policyDetails: {
        resourceTypes: ['VOLUME'],
        targetTags: [
          {
            key: 'Backup',
            value: 'weekly-dlm',
          },
        ],
        schedules: [
          {
            name: 'Weekly Friday Backup',
            copyTags: true,
            createRule: {
              cronExpression: 'cron(30 19 ? * FRI *)',
            },
            retainRule: {
              count: 4,
            },
            tagsToAdd: [
              {
                key: 'SnapshotType',
                value: 'Automated',
              },
              {
                key: 'CreatedBy',
                value: 'DLM',
              },
            ],
          },
        ],
      },
    });

    // Note: ECR Lifecycle Policy cannot be managed by CDK due to Lambda SCP restrictions
    // To manage ECR lifecycle policy manually, use AWS CLI:
    // aws ecr put-lifecycle-policy --repository-name youtrack --lifecycle-policy-text file://ecr-lifecycle-policy.json --region eu-west-1

    // Stack outputs
    new cdk.CfnOutput(this, 'StartScheduleArn', {
      value: startSchedule.attrArn,
      description: 'ARN of the start schedule',
    });

    new cdk.CfnOutput(this, 'StopScheduleArn', {
      value: stopSchedule.attrArn,
      description: 'ARN of the stop schedule',
    });

    new cdk.CfnOutput(this, 'DlmPolicyArn', {
      value: dlmPolicy.attrArn,
      description: 'ARN of the DLM lifecycle policy',
    });

    new cdk.CfnOutput(this, 'ScheduleSummary', {
      value: 'Mon-Fri: Start at 08:00 UTC, Stop at 19:00 UTC',
      description: 'Schedule summary',
    });

    new cdk.CfnOutput(this, 'BackupSummary', {
      value: 'Weekly snapshots on Friday at 19:30 UTC, retaining 4 snapshots',
      description: 'Backup policy summary',
    });

    new cdk.CfnOutput(this, 'InstanceId', {
      value: instanceId,
      description: 'YouTrack EC2 instance ID',
    });

    new cdk.CfnOutput(this, 'Note', {
      value: 'ECR lifecycle policy must be managed manually via AWS CLI due to Lambda SCP restrictions',
      description: 'ECR lifecycle note',
    });
  }
}
