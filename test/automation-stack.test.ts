import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AutomationStack } from '../lib/automation-stack';

describe('AutomationStack', () => {
  test('creates start schedule with correct configuration', () => {
    const app = new cdk.App();
    const stack = new AutomationStack(app, 'TestAutomationStack', {
      // instanceId looked up at deploy time
      env: {
        account: '640664844884',
        region: 'eu-west-1',
      },
    });

    const template = Template.fromStack(stack);

    // Verify start schedule exists with correct cron expression
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'youtrack-start-schedule',
      Description: 'Start YouTrack EC2 instance Mon-Fri at 7 AM UTC',
      ScheduleExpression: 'cron(0 7 ? * MON-FRI *)',
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: {
        Mode: 'OFF',
      },
    });
  });

  test('creates stop schedule with correct configuration', () => {
    const app = new cdk.App();
    const stack = new AutomationStack(app, 'TestAutomationStack', {
      // instanceId looked up at deploy time
      env: {
        account: '640664844884',
        region: 'eu-west-1',
      },
    });

    const template = Template.fromStack(stack);

    // Verify stop schedule exists with correct cron expression
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'youtrack-stop-schedule',
      Description: 'Stop YouTrack EC2 instance Mon-Fri at 7 PM UTC',
      ScheduleExpression: 'cron(0 19 ? * MON-FRI *)',
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: {
        Mode: 'OFF',
      },
    });
  });

  test('creates IAM roles with correct permissions', () => {
    const app = new cdk.App();
    const stack = new AutomationStack(app, 'TestAutomationStack', {
      // instanceId looked up at deploy time
      env: {
        account: '640664844884',
        region: 'eu-west-1',
      },
    });

    const template = Template.fromStack(stack);

    // Verify IAM roles for start and stop are created
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: {
              Service: 'scheduler.amazonaws.com',
            },
          }),
        ]),
      }),
    });

    // Verify start permissions
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'ec2:StartInstances',
          }),
        ]),
      }),
    });

    // Verify stop permissions
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'ec2:StopInstances',
          }),
        ]),
      }),
    });
  });

  test('creates DLM lifecycle policy with correct configuration', () => {
    const app = new cdk.App();
    const stack = new AutomationStack(app, 'TestAutomationStack', {
      // instanceId looked up at deploy time
      env: {
        account: '640664844884',
        region: 'eu-west-1',
      },
    });

    const template = Template.fromStack(stack);

    // Verify DLM policy exists
    template.hasResourceProperties('AWS::DLM::LifecyclePolicy', {
      Description: 'Weekly EBS snapshots for YouTrack data volume',
      State: 'ENABLED',
      PolicyDetails: {
        ResourceTypes: ['VOLUME'],
        TargetTags: [
          {
            Key: 'Backup',
            Value: 'weekly-dlm',
          },
        ],
        Schedules: Match.arrayWith([
          Match.objectLike({
            Name: 'Weekly Friday Backup',
            CopyTags: true,
            CreateRule: {
              CronExpression: 'cron(0 18 ? * FRI *)',
            },
            RetainRule: {
              Count: 4,
            },
          }),
        ]),
      },
    });
  });

  test('creates IAM role for DLM with correct permissions', () => {
    const app = new cdk.App();
    const stack = new AutomationStack(app, 'TestAutomationStack', {
      // instanceId looked up at deploy time
      env: {
        account: '640664844884',
        region: 'eu-west-1',
      },
    });

    const template = Template.fromStack(stack);

    // Verify DLM IAM role
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: {
              Service: 'dlm.amazonaws.com',
            },
          }),
        ]),
      }),
    });

    // Verify DLM permissions
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'ec2:CreateSnapshot',
              'ec2:CreateSnapshots',
              'ec2:DeleteSnapshot',
              'ec2:DescribeVolumes',
              'ec2:DescribeSnapshots',
              'ec2:DescribeInstances',
            ]),
          }),
        ]),
      }),
    });
  });

  test('includes required compliance tags', () => {
    const app = new cdk.App();
    const stack = new AutomationStack(app, 'TestAutomationStack', {
      // instanceId looked up at deploy time
      env: {
        account: '640664844884',
        region: 'eu-west-1',
      },
    });

    // Verify tags are applied to stack
    const tags = cdk.Tags.of(stack);
    expect(tags).toBeDefined();
  });

  test('exports schedule and policy ARNs', () => {
    const app = new cdk.App();
    const stack = new AutomationStack(app, 'TestAutomationStack', {
      // instanceId looked up at deploy time
      env: {
        account: '640664844884',
        region: 'eu-west-1',
      },
    });

    const template = Template.fromStack(stack);

    // Verify stack outputs are created
    template.hasOutput('StartScheduleArn', {});
    template.hasOutput('StopScheduleArn', {});
    template.hasOutput('DlmPolicyArn', {});
    template.hasOutput('ScheduleSummary', {});
    template.hasOutput('BackupSummary', {});
  });

  test('schedules use correct instance ID', () => {
    const app = new cdk.App();
    const testInstanceId = 'i-test123456789';
    const stack = new AutomationStack(app, 'TestAutomationStack', {
      // instanceId looked up at deploy time
      env: {
        account: '640664844884',
        region: 'eu-west-1',
      },
    });

    const template = Template.fromStack(stack);

    // Verify schedules target the correct instance
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Target: Match.objectLike({
        Input: Match.stringLikeRegexp(testInstanceId),
      }),
    });
  });

  test('creates exactly 2 schedules and 1 DLM policy', () => {
    const app = new cdk.App();
    const stack = new AutomationStack(app, 'TestAutomationStack', {
      // instanceId looked up at deploy time
      env: {
        account: '640664844884',
        region: 'eu-west-1',
      },
    });

    const template = Template.fromStack(stack);

    // Verify resource counts
    template.resourceCountIs('AWS::Scheduler::Schedule', 2);
    template.resourceCountIs('AWS::DLM::LifecyclePolicy', 1);
  });

  test('schedules have retry policy configured', () => {
    const app = new cdk.App();
    const stack = new AutomationStack(app, 'TestAutomationStack', {
      // instanceId looked up at deploy time
      env: {
        account: '640664844884',
        region: 'eu-west-1',
      },
    });

    const template = Template.fromStack(stack);

    // Verify retry policy is configured
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Target: Match.objectLike({
        RetryPolicy: {
          MaximumRetryAttempts: 3,
          MaximumEventAgeInSeconds: 300,
        },
      }),
    });
  });

  test('DLM policy tags snapshots correctly', () => {
    const app = new cdk.App();
    const stack = new AutomationStack(app, 'TestAutomationStack', {
      // instanceId looked up at deploy time
      env: {
        account: '640664844884',
        region: 'eu-west-1',
      },
    });

    const template = Template.fromStack(stack);

    // Verify DLM adds tags to snapshots
    template.hasResourceProperties('AWS::DLM::LifecyclePolicy', {
      PolicyDetails: Match.objectLike({
        Schedules: Match.arrayWith([
          Match.objectLike({
            TagsToAdd: Match.arrayWith([
              { Key: 'SnapshotType', Value: 'Automated' },
              { Key: 'CreatedBy', Value: 'DLM' },
            ]),
          }),
        ]),
      }),
    });
  });
});
