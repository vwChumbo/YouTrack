import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dlm from 'aws-cdk-lib/aws-dlm';
import * as cr from 'aws-cdk-lib/custom-resources';

export interface AutomationStackProps extends cdk.StackProps {
  // No instance ID needed - will be looked up by tag at deploy time
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

    // Look up YouTrack instance ID by tag at deploy time
    // This avoids cross-stack reference that prevents instance replacement
    const instanceLookup = new cr.AwsCustomResource(this, 'YouTrackInstanceLookup', {
      onUpdate: {
        service: 'EC2',
        action: 'describeInstances',
        parameters: {
          Filters: [
            {
              Name: 'tag:Project',
              Values: ['YouTrack'],
            },
            {
              Name: 'tag:aws:cloudformation:stack-name',
              Values: ['YouTrackStack-Local'],
            },
            {
              Name: 'instance-state-name',
              Values: ['running', 'stopped'],
            },
          ],
        },
        physicalResourceId: cr.PhysicalResourceId.of('youtrack-instance-lookup'),
        outputPaths: ['Reservations.0.Instances.0.InstanceId'],
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['ec2:DescribeInstances'],
          resources: ['*'],
        }),
      ]),
    });

    const instanceId = instanceLookup.getResponseField('Reservations.0.Instances.0.InstanceId');

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
              cronExpression: 'cron(0 18 ? * FRI *)',
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

    // ECR Lifecycle Policy for YouTrack image cleanup
    // Using AwsCustomResource because the repository exists and we can't import it with lifecycle rules
    const ecrLifecyclePolicy = new cr.AwsCustomResource(this, 'YouTrackEcrLifecyclePolicy', {
      onCreate: {
        service: 'ECR',
        action: 'putLifecyclePolicy',
        parameters: {
          repositoryName: 'youtrack',
          lifecyclePolicyText: JSON.stringify({
            rules: [
              {
                rulePriority: 1,
                description: 'Keep latest 5 tagged images',
                selection: {
                  tagStatus: 'tagged',
                  countType: 'imageCountMoreThan',
                  countNumber: 5,
                },
                action: {
                  type: 'expire',
                },
              },
              {
                rulePriority: 2,
                description: 'Remove tagged images older than 30 days',
                selection: {
                  tagStatus: 'tagged',
                  countType: 'sinceImagePushed',
                  countUnit: 'days',
                  countNumber: 30,
                },
                action: {
                  type: 'expire',
                },
              },
              {
                rulePriority: 3,
                description: 'Remove untagged images older than 7 days',
                selection: {
                  tagStatus: 'untagged',
                  countType: 'sinceImagePushed',
                  countUnit: 'days',
                  countNumber: 7,
                },
                action: {
                  type: 'expire',
                },
              },
            ],
          }),
        },
        physicalResourceId: cr.PhysicalResourceId.of('youtrack-lifecycle-policy'),
      },
      onUpdate: {
        service: 'ECR',
        action: 'putLifecyclePolicy',
        parameters: {
          repositoryName: 'youtrack',
          lifecyclePolicyText: JSON.stringify({
            rules: [
              {
                rulePriority: 1,
                description: 'Keep latest 5 tagged images',
                selection: {
                  tagStatus: 'tagged',
                  countType: 'imageCountMoreThan',
                  countNumber: 5,
                },
                action: {
                  type: 'expire',
                },
              },
              {
                rulePriority: 2,
                description: 'Remove tagged images older than 30 days',
                selection: {
                  tagStatus: 'tagged',
                  countType: 'sinceImagePushed',
                  countUnit: 'days',
                  countNumber: 30,
                },
                action: {
                  type: 'expire',
                },
              },
              {
                rulePriority: 3,
                description: 'Remove untagged images older than 7 days',
                selection: {
                  tagStatus: 'untagged',
                  countType: 'sinceImagePushed',
                  countUnit: 'days',
                  countNumber: 7,
                },
                action: {
                  type: 'expire',
                },
              },
            ],
          }),
        },
        physicalResourceId: cr.PhysicalResourceId.of('youtrack-lifecycle-policy'),
      },
      onDelete: {
        service: 'ECR',
        action: 'deleteLifecyclePolicy',
        parameters: {
          repositoryName: 'youtrack',
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'ecr:PutLifecyclePolicy',
            'ecr:DeleteLifecyclePolicy',
            'ecr:GetLifecyclePolicy',
          ],
          resources: [
            `arn:aws:ecr:${this.region}:${this.account}:repository/youtrack`,
          ],
        }),
      ]),
    });

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
      value: 'Mon-Fri: Start at 07:00 UTC, Stop at 19:00 UTC',
      description: 'Schedule summary',
    });

    new cdk.CfnOutput(this, 'BackupSummary', {
      value: 'Weekly snapshots on Friday at 18:00 UTC, retaining 4 snapshots',
      description: 'Backup policy summary',
    });

    new cdk.CfnOutput(this, 'EcrRepositoryName', {
      value: 'youtrack',
      description: 'YouTrack ECR repository name',
    });

    new cdk.CfnOutput(this, 'EcrLifecycleSummary', {
      value: 'Keep latest 5 tagged images OR images <30 days, remove untagged >7 days',
      description: 'ECR lifecycle policy summary',
    });
  }
}
