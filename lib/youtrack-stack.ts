import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { SharedVpc, KeyStack, KeyPurpose } from '@vwg-community/vws-cdk';

export interface YouTrackStackProps extends cdk.StackProps {
  /**
   * Availability Zone for EC2 instance and EBS volume
   * @default 'eu-west-1a'
   */
  availabilityZone?: string;
}

export class YouTrackStack extends cdk.Stack {
  public readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props?: YouTrackStackProps) {
    super(scope, id, props);

    // Get availability zone from props (no default - let VPC choose)
    const availabilityZone = props?.availabilityZone;

    // Add compliance tags
    cdk.Tags.of(this).add('Environment', 'production');
    cdk.Tags.of(this).add('Project', 'YouTrack');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Owner', 'a2i5giv');
    cdk.Tags.of(this).add('Purpose', 'Issue-Tracking');

    // Import Shared VPC (required by SCP)
    const sharedVpc = new SharedVpc(this, 'SharedVpc');

    // Lookup shared CICD KMS key from KeyStack
    const cicdKey = KeyStack.getKeyFromLookup(this, 'CicdKeyLookup', KeyPurpose.CICD);

    // CloudWatch log group for SSM Session Manager logs
    const ssmLogGroup = new logs.LogGroup(this, 'SsmSessionLogs', {
      logGroupName: '/aws/ssm/YouTrack',
      encryptionKey: cicdKey,
      retention: logs.RetentionDays.ONE_YEAR,
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

    // Grant instance role permission to use logs KMS key
    cicdKey.grantEncryptDecrypt(instanceRole);

    // UserData script to install Docker and run YouTrack
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
      '# Wait for device to be available',
      'for i in {1..30}; do',
      '  if [ -e /dev/sdf ]; then break; fi',
      '  echo "Waiting for /dev/sdf to be available..."',
      '  sleep 1',
      'done',
      '',
      '# Check if volume is already formatted (has a filesystem)',
      'if ! blkid /dev/sdf; then',
      '  echo "Formatting /dev/sdf as ext4"',
      '  mkfs -t ext4 /dev/sdf',
      'else',
      '  echo "/dev/sdf already formatted, skipping format"',
      'fi',
      '',
      '# Create mount point',
      'mkdir -p /var/youtrack-data',
      '',
      '# Add to fstab if not already present',
      'if ! grep -q "/dev/sdf" /etc/fstab; then',
      '  echo "/dev/sdf /var/youtrack-data ext4 defaults,nofail 0 2" >> /etc/fstab',
      'fi',
      '',
      '# Mount the volume',
      'mount -a',
      '',
      '# Create subdirectories for all 4 YouTrack volumes',
      'mkdir -p /var/youtrack-data/{data,conf,logs,backups}',
      '',
      '# Set ownership and permissions for YouTrack container (UID 13001)',
      'chown -R 13001:13001 /var/youtrack-data',
      'chmod -R 755 /var/youtrack-data',
      '',
      '# Login to ECR',
      'aws ecr get-login-password --region eu-west-1 | \\',
      '  docker login --username AWS --password-stdin \\',
      '  640664844884.dkr.ecr.eu-west-1.amazonaws.com',
      '',
      '# Run YouTrack container from ECR with all 4 volume mounts',
      'docker run -d --name youtrack --restart=always \\',
      '  -p 8080:8080 \\',
      '  -v /var/youtrack-data/data:/opt/youtrack/data \\',
      '  -v /var/youtrack-data/conf:/opt/youtrack/conf \\',
      '  -v /var/youtrack-data/logs:/opt/youtrack/logs \\',
      '  -v /var/youtrack-data/backups:/opt/youtrack/backups \\',
      '  640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:2026.1.12458',
      '',
      '# Setup YouTrack internal backup cron job (daily at 2AM UTC)',
      'cat > /etc/cron.d/youtrack-backup << EOF',
      '0 2 * * * root docker exec youtrack java -jar /opt/youtrack/lib/hub.jar backup',
      'EOF',
      'chmod 0644 /etc/cron.d/youtrack-backup',
      '',
      '# Signal completion',
      'echo "YouTrack deployment complete at $(date)" > /var/log/youtrack-setup.log'
    );

    // Create EC2 instance
    // Using AMI from image factory (One.Cloud requirement)
    // IF20-amzn2-GROUP-PROD-20260403220337-AMI (Amazon Linux 2, x86_64)
    // t3.medium (4GB RAM) required for YouTrack 2026.1 - t3.small caused OOM errors

    // Select ONE specific subnet to avoid AZ ambiguity
    // Take the first PRIVATE_ISOLATED subnet available in the VPC
    const selectedSubnets = sharedVpc.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      onePerAz: true,  // Get one subnet per AZ
    });

    // Use the first subnet's AZ explicitly
    const targetAz = availabilityZone || selectedSubnets.subnets[0].availabilityZone;

    this.instance = new ec2.Instance(this, 'YouTrackInstance', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      machineImage: ec2.MachineImage.genericLinux({
        'eu-west-1': 'ami-0b434d403262ef6c7',
      }),
      vpc: sharedVpc.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        availabilityZones: [targetAz],  // Filter to match the target AZ
      },
      availabilityZone: targetAz,
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
            kmsKey: cicdKey,
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
      encryptionKey: cicdKey,  // Use customer-managed key
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
      value: cicdKey.keyId,
      description: 'KMS Key ID for EBS encryption',
    });

    new cdk.CfnOutput(this, 'KmsKeyArn', {
      value: cicdKey.keyArn,
      description: 'KMS Key ARN for EBS encryption',
    });
  }
}
