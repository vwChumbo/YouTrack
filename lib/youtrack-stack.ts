import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { SharedVpc } from '@vwg-community/vws-cdk';

export class YouTrackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Add compliance tags
    cdk.Tags.of(this).add('Environment', 'production');
    cdk.Tags.of(this).add('Project', 'YouTrack');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Owner', 'a2i5giv');
    cdk.Tags.of(this).add('Purpose', 'Issue-Tracking');

    // Import Shared VPC (required by SCP)
    const sharedVpc = new SharedVpc(this, 'SharedVpc');

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
      '# Create data directory on root volume',
      'mkdir -p /var/youtrack-data',
      '',
      '# Run YouTrack container',
      'docker run -d --name youtrack --restart=always \\',
      '  -p 8080:8080 \\',
      '  -v /var/youtrack-data:/opt/youtrack/data \\',
      '  jetbrains/youtrack:2024.3',
      '',
      '# Signal completion',
      'echo "YouTrack deployment complete at $(date)" > /var/log/youtrack-setup.log'
    );

    // Create EC2 instance
    // Using AMI from image factory (One.Cloud requirement)
    // IF20-amzn2-GROUP-PROD-20260403220337-AMI (Amazon Linux 2, x86_64)
    const instance = new ec2.Instance(this, 'YouTrackInstance', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.genericLinux({
        'eu-west-1': 'ami-0b434d403262ef6c7',
      }),
      vpc: sharedVpc.vpc,
      vpcSubnets: sharedVpc.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      }),
      securityGroup: securityGroup,
      role: instanceRole,
      userData: userData,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(30, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    });

    // Outputs
    new cdk.CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'EC2 Instance ID',
    });

    new cdk.CfnOutput(this, 'PrivateIp', {
      value: instance.instancePrivateIp,
      description: 'EC2 Instance Private IP',
    });

    new cdk.CfnOutput(this, 'AccessUrl', {
      value: `http://${instance.instancePrivateIp}:8080`,
      description: 'YouTrack Access URL',
    });

    new cdk.CfnOutput(this, 'SsmConnect', {
      value: `aws ssm start-session --target ${instance.instanceId} --region ${this.region}`,
      description: 'SSM Session Manager connect command',
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: sharedVpc.vpc.vpcId,
      description: 'Shared VPC ID',
    });
  }
}
