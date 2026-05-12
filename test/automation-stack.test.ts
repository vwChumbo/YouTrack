import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AutomationStack } from '../lib/automation-stack';

const TEST_INSTANCE_ID = 'i-test123456789abcdef0';
const TEST_ENV = { account: '640664844884', region: 'eu-west-1' };

function makeStack() {
  const app = new cdk.App();
  return new AutomationStack(app, 'TestAutomationStack', {
    instanceId: TEST_INSTANCE_ID,
    env: TEST_ENV,
  });
}

describe('AutomationStack', () => {
  test('creates primary start schedule at 06:00 UTC', () => {
    const template = Template.fromStack(makeStack());
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'youtrack-start-schedule',
      Description: 'Start YouTrack EC2 instance Mon-Fri at 06:00 UTC (1-2h before work)',
      ScheduleExpression: 'cron(0 6 ? * MON-FRI *)',
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
    });
  });

  test('creates backup start schedule at 06:30 UTC', () => {
    const template = Template.fromStack(makeStack());
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'youtrack-start-schedule-backup',
      Description: 'Backup start for YouTrack EC2 instance Mon-Fri at 06:30 UTC',
      ScheduleExpression: 'cron(30 6 ? * MON-FRI *)',
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
    });
  });

  test('creates stop schedule at 19:00 UTC', () => {
    const template = Template.fromStack(makeStack());
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'youtrack-stop-schedule',
      Description: 'Stop YouTrack EC2 instance Mon-Fri at 7 PM UTC',
      ScheduleExpression: 'cron(0 19 ? * MON-FRI *)',
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
    });
  });

  test('creates exactly 3 schedules (primary start, backup start, stop)', () => {
    const template = Template.fromStack(makeStack());
    template.resourceCountIs('AWS::Scheduler::Schedule', 3);
  });

  test('creates 1 DLM lifecycle policy', () => {
    const template = Template.fromStack(makeStack());
    template.resourceCountIs('AWS::DLM::LifecyclePolicy', 1);
  });

  test('all schedules target the provided instance ID', () => {
    const template = Template.fromStack(makeStack());
    const schedules = template.findResources('AWS::Scheduler::Schedule');
    const scheduleList = Object.values(schedules);
    expect(scheduleList).toHaveLength(3);
    scheduleList.forEach((schedule: any) => {
      expect(schedule.Properties.Target.Input).toContain(TEST_INSTANCE_ID);
    });
  });

  test('start roles use ec2:StartInstances with Project=YouTrack tag condition', () => {
    const template = Template.fromStack(makeStack());
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'ec2:StartInstances',
            Condition: { StringEquals: { 'ec2:ResourceTag/Project': 'YouTrack' } },
          }),
        ]),
      }),
    });
  });

  test('stop role uses ec2:StopInstances with Project=YouTrack tag condition', () => {
    const template = Template.fromStack(makeStack());
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'ec2:StopInstances',
            Condition: { StringEquals: { 'ec2:ResourceTag/Project': 'YouTrack' } },
          }),
        ]),
      }),
    });
  });

  test('scheduler roles are assumed by scheduler.amazonaws.com', () => {
    const template = Template.fromStack(makeStack());
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Principal: { Service: 'scheduler.amazonaws.com' } }),
        ]),
      }),
    });
  });

  test('DLM policy targets volumes tagged Backup=weekly-dlm', () => {
    const template = Template.fromStack(makeStack());
    template.hasResourceProperties('AWS::DLM::LifecyclePolicy', {
      Description: 'Weekly EBS snapshots for YouTrack data volume',
      State: 'ENABLED',
      PolicyDetails: Match.objectLike({
        ResourceTypes: ['VOLUME'],
        TargetTags: [{ Key: 'Backup', Value: 'weekly-dlm' }],
        Schedules: Match.arrayWith([
          Match.objectLike({
            Name: 'Weekly Friday Backup',
            RetainRule: { Count: 4 },
          }),
        ]),
      }),
    });
  });

  test('all schedules have retry policy with 3 attempts and 5 min event age', () => {
    const template = Template.fromStack(makeStack());
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Target: Match.objectLike({
        RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 300 },
      }),
    });
  });

  test('exports required stack outputs', () => {
    const template = Template.fromStack(makeStack());
    template.hasOutput('StartScheduleArn', {});
    template.hasOutput('StopScheduleArn', {});
    template.hasOutput('DlmPolicyArn', {});
    template.hasOutput('ScheduleSummary', {});
    template.hasOutput('BackupSummary', {});
  });
});
