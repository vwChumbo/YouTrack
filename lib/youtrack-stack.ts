import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import { SharedVpc, KeyStack, KeyPurpose } from '@vwg-community/vws-cdk';

export interface YouTrackStackProps extends cdk.StackProps {
  // No additional props needed
}

export class YouTrackStack extends cdk.Stack {
  public readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props?: YouTrackStackProps) {
    super(scope, id, props);

    // Add compliance tags
    cdk.Tags.of(this).add('Environment', 'production');
    cdk.Tags.of(this).add('Project', 'YouTrack');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Owner', 'a2i5giv');
    cdk.Tags.of(this).add('Purpose', 'Issue-Tracking');

    // Import Shared VPC (required by SCP)
    const sharedVpc = new SharedVpc(this, 'SharedVpc');

    // Get APP KMS key from lookup for application resources (EBS, Logs)
    // Use APP_PROD since this is production environment
    const appKey = KeyStack.getKeyFromLookup(this, 'AppKeyLookup', KeyPurpose.APP_PROD);

    // CloudWatch log group for SSM Session Manager logs
    const ssmLogGroup = new logs.LogGroup(this, 'SsmSessionLogs', {
      logGroupName: '/aws/ssm/YouTrack',
      encryptionKey: appKey,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // CloudWatch log groups for instance observability
    // All encrypted with customer-managed KMS key (One.Cloud: no AWS-managed keys)
    // All removalPolicy: RETAIN — preserves logs if stack is updated or destroyed
    const cloudInitLogGroup = new logs.LogGroup(this, 'CloudInitLogs', {
      logGroupName: '/aws/ec2/youtrack/cloud-init',
      encryptionKey: appKey,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const systemLogGroup = new logs.LogGroup(this, 'SystemLogs', {
      logGroupName: '/aws/ec2/youtrack/system',
      encryptionKey: appKey,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const containerLogGroup = new logs.LogGroup(this, 'ContainerLogs', {
      logGroupName: '/aws/ec2/youtrack/container',
      encryptionKey: appKey,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const stateChangeLogGroup = new logs.LogGroup(this, 'StateChangeLogs', {
      logGroupName: '/aws/ec2/youtrack/state-changes',
      encryptionKey: appKey,
      retention: logs.RetentionDays.SIX_MONTHS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Security group for YouTrack EC2 instance
    const securityGroup = new ec2.SecurityGroup(this, 'YouTrackSecurityGroup', {
      vpc: sharedVpc.vpc,
      description: 'Security group for YouTrack EC2 instance',
      allowAllOutbound: true,
    });

    // Allow inbound traffic on port 8080 from private IP ranges (VPC is private)
    // Using RFC 1918 private address spaces since SharedVpc doesn't expose vpcCidrBlock
    securityGroup.addIngressRule(
      ec2.Peer.ipv4('10.0.0.0/8'),
      ec2.Port.tcp(8080),
      'Allow YouTrack access from 10.0.0.0/8'
    );
    securityGroup.addIngressRule(
      ec2.Peer.ipv4('172.16.0.0/12'),
      ec2.Port.tcp(8080),
      'Allow YouTrack access from 172.16.0.0/12'
    );
    securityGroup.addIngressRule(
      ec2.Peer.ipv4('192.168.0.0/16'),
      ec2.Port.tcp(8080),
      'Allow YouTrack access from 192.168.0.0/16'
    );

    cdk.Tags.of(securityGroup).add('Name', `${this.stackName}-youtrack-sg`);

    // IAM role for EC2 instance with SSM access
    const instanceRole = new iam.Role(this, 'YouTrackInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Add ECR permissions for pulling Docker images
    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
      ],
      resources: ['*'], // GetAuthorizationToken requires '*'
    }));

    // Add CloudWatch Logs permissions
    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [ssmLogGroup.logGroupArn],
    }));

    // CW Agent + Docker awslogs driver: write access to all 4 observability log groups
    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:DescribeLogStreams',
      ],
      resources: [
        cloudInitLogGroup.logGroupArn,
        systemLogGroup.logGroupArn,
        containerLogGroup.logGroupArn,
        stateChangeLogGroup.logGroupArn,
      ],
    }));

    // CW Agent metrics — resource '*' is an AWS requirement, cannot be scoped further
    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));

    // Grant instance role permission to use logs KMS key
    appKey.grantEncryptDecrypt(instanceRole);

    // UserData script to install Docker, run YouTrack, and configure CloudWatch Agent
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'set -euxo pipefail',
      '',
      '# Install Docker',
      'yum update -y',
      'yum install -y docker',
      'systemctl start docker',
      'systemctl enable docker',
      'usermod -aG docker ec2-user',
      '',
      '# Configure EBS data volume',
      'for i in {1..30}; do',
      '  if [ -e /dev/sdf ]; then break; fi',
      '  echo "Waiting for /dev/sdf to be available..."',
      '  sleep 1',
      'done',
      '',
      'if ! blkid /dev/sdf; then',
      '  echo "Formatting /dev/sdf as ext4"',
      '  mkfs -t ext4 /dev/sdf',
      'else',
      '  echo "/dev/sdf already formatted, skipping format"',
      'fi',
      '',
      'mkdir -p /var/youtrack-data',
      '',
      'if ! grep -q "/dev/sdf" /etc/fstab; then',
      '  echo "/dev/sdf /var/youtrack-data ext4 defaults,nofail 0 2" >> /etc/fstab',
      'fi',
      '',
      'mount -a',
      '',
      'mkdir -p /var/youtrack-data/{data,conf,logs,backups}',
      '',
      '# Set ownership and permissions for YouTrack container (UID/GID 13001)',
      'chown -R 13001:13001 /var/youtrack-data',
      'chmod -R 755 /var/youtrack-data',
      '',
      '# Login to ECR',
      'aws ecr get-login-password --region eu-west-1 | \\',
      '  docker login --username AWS --password-stdin \\',
      '  640664844884.dkr.ecr.eu-west-1.amazonaws.com',
      '',
      '# Run YouTrack container with CloudWatch log driver',
      'docker run -d --name youtrack --restart=always \\',
      '  --log-driver=awslogs \\',
      '  --log-opt awslogs-region=eu-west-1 \\',
      '  --log-opt awslogs-group=/aws/ec2/youtrack/container \\',
      '  --log-opt awslogs-stream=youtrack \\',
      '  -p 8080:8080 \\',
      '  -v /var/youtrack-data/data:/opt/youtrack/data \\',
      '  -v /var/youtrack-data/conf:/opt/youtrack/conf \\',
      '  -v /var/youtrack-data/logs:/opt/youtrack/logs \\',
      '  -v /var/youtrack-data/backups:/opt/youtrack/backups \\',
      '  640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:latest',
      '',
      '# Internal backup cron job (daily 2AM UTC)',
      "cat > /etc/cron.d/youtrack-backup << 'EOF'",
      '0 2 * * * root docker exec youtrack java -jar /opt/youtrack/lib/hub.jar backup',
      'EOF',
      'chmod 0644 /etc/cron.d/youtrack-backup',
      '',
      '# Install and configure CloudWatch Agent',
      'yum install -y amazon-cloudwatch-agent',
      "cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'CWEOF'",
      '{',
      '  "logs": {',
      '    "logs_collected": {',
      '      "files": {',
      '        "collect_list": [',
      '          {',
      '            "file_path": "/var/log/cloud-init-output.log",',
      '            "log_group_name": "/aws/ec2/youtrack/cloud-init",',
      '            "log_stream_name": "{instance_id}",',
      '            "timezone": "UTC"',
      '          },',
      '          {',
      '            "file_path": "/var/log/messages",',
      '            "log_group_name": "/aws/ec2/youtrack/system",',
      '            "log_stream_name": "{instance_id}",',
      '            "timezone": "UTC"',
      '          }',
      '        ]',
      '      }',
      '    }',
      '  }',
      '}',
      'CWEOF',
      'systemctl enable amazon-cloudwatch-agent',
      'systemctl start amazon-cloudwatch-agent',
      '',
      'echo "YouTrack deployment complete at $(date)" > /var/log/youtrack-setup.log'
    );

    // Create EC2 instance
    // Using AMI from image factory (One.Cloud requirement)
    // IF20-amzn2-GROUP-PROD-20260403220337-AMI (Amazon Linux 2, x86_64)
    // t3.medium (4GB RAM) required for YouTrack 2026.1 - t3.small caused OOM errors

    // Select PRIVATE_ISOLATED subnets
    // CDK's ec2.Instance construct resolves to a specific subnet/AZ at synthesis time
    // We let CDK pick the first available PRIVATE_ISOLATED subnet
    const subnets = sharedVpc.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
    });

    this.instance = new ec2.Instance(this, 'YouTrackInstance', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      machineImage: ec2.MachineImage.genericLinux({
        'eu-west-1': 'ami-0b434d403262ef6c7',
      }),
      vpc: sharedVpc.vpc,
      vpcSubnets: {
        subnets: subnets.subnets,
      },
      // Do not specify availabilityZone - CDK will pick subnet's AZ automatically
      securityGroup: securityGroup,
      role: instanceRole,
      userData: userData,
      requireImdsv2: true,  // Enforce IMDSv2 for metadata security
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(30, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            kmsKey: appKey,
          }),
        },
      ],
    });

    // Create separate EBS volume for YouTrack data
    // This allows clean backups via DLM snapshots and data persistence across instance replacements
    const dataVolume = new ec2.Volume(this, 'YouTrackDataVolumeEncrypted', {
      // Use instance's AZ to ensure volume and instance are co-located
      availabilityZone: this.instance.instanceAvailabilityZone,
      size: cdk.Size.gibibytes(50),  // Fresh 50GB volume
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
      encryptionKey: appKey,  // Use customer-managed key
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    // Tag the data volume for DLM backup policy
    cdk.Tags.of(dataVolume).add('Name', 'youtrack-data');
    cdk.Tags.of(dataVolume).add('Backup', 'weekly-dlm');

    // Attach data volume to EC2 instance
    // Device name /dev/sdf will be used in UserData for mounting
    new ec2.CfnVolumeAttachment(this, 'YouTrackDataVolumeAttachment', {
      volumeId: dataVolume.volumeId,
      instanceId: this.instance.instanceId,
      device: '/dev/sdf',
    });

    // Resource policy: allow EventBridge to write state-change events to CloudWatch Logs.
    // CfnResourcePolicy (L1) is used directly — the L2 CloudWatchLogGroup events target
    // creates a Lambda-backed Custom Resource which is blocked by the One.Cloud Lambda SCP.
    new logs.CfnResourcePolicy(this, 'EventBridgeLogGroupPolicy', {
      policyName: 'YouTrackEventBridgeToCloudWatchLogs',
      policyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'events.amazonaws.com' },
            Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            Resource: `${stateChangeLogGroup.logGroupArn}:*`,
            Condition: {
              ArnEquals: {
                'aws:SourceArn': `arn:aws:events:${this.region}:${this.account}:rule/*`,
              },
            },
          },
        ],
      }),
    });

    // EventBridge rule: capture every EC2 state change for this instance.
    // Healthy morning: stopped → pending → running
    // Failed morning:  pending → stopped  (no 'running' = immediate failure signal in CloudWatch)
    // CfnRule (L1) targets the log group ARN directly — no Lambda Custom Resource needed.
    new events.CfnRule(this, 'InstanceStateChangeRule', {
      description: 'Log EC2 state changes for YouTrack instance to CloudWatch',
      state: 'ENABLED',
      eventPattern: {
        source: ['aws.ec2'],
        'detail-type': ['EC2 Instance State-change Notification'],
        detail: {
          'instance-id': [this.instance.instanceId],
        },
      },
      targets: [
        {
          id: 'CloudWatchLogsTarget',
          arn: stateChangeLogGroup.logGroupArn,
        },
      ],
    });

    // Outputs
    new cdk.CfnOutput(this, 'InstanceId', {
      value: this.instance.instanceId,
      description: 'EC2 Instance ID',
    });

    new cdk.CfnOutput(this, 'PrivateIp', {
      value: this.instance.instancePrivateIp,
      description: 'EC2 Instance Private IP',
    });

    new cdk.CfnOutput(this, 'AccessUrl', {
      value: `http://${this.instance.instancePrivateIp}:8080`,
      description: 'YouTrack Access URL',
    });

    new cdk.CfnOutput(this, 'SsmConnect', {
      value: `aws ssm start-session --target ${this.instance.instanceId} --region ${this.region}`,
      description: 'SSM Session Manager connect command',
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: sharedVpc.vpc.vpcId,
      description: 'Shared VPC ID',
    });

    new cdk.CfnOutput(this, 'KmsKeyId', {
      value: appKey.keyId,
      description: 'KMS Key ID for EBS encryption',
    });

    new cdk.CfnOutput(this, 'KmsKeyArn', {
      value: appKey.keyArn,
      description: 'KMS Key ARN for EBS encryption',
    });
  }
}
