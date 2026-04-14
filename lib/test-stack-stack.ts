import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { SharedVpc } from '@vwg-community/vws-cdk';

export class TestStackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Add stack-level tags that may be required by SCP
    cdk.Tags.of(this).add('Environment', 'test');
    cdk.Tags.of(this).add('Project', 'CDK-Testing');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Owner', 'a2i5giv');
    cdk.Tags.of(this).add('Purpose', 'CDK-Bootstrap-Test');
    cdk.Tags.of(this).add('CostCenter', 'Development');

    // Create Shared VPC (required by SCP for Lambda functions)
    const sharedVpc = new SharedVpc(this, 'SharedVpc');

    // Create security group for Lambda functions
    const securityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc: sharedVpc.vpc,
      description: `${this.stackName}-lambda-security-group`,
      allowAllOutbound: true,
    });
    cdk.Tags.of(securityGroup).add('Name', `${this.stackName}-lambda-sg`);

    // Create S3 bucket with auto-delete enabled for easy cleanup
    const bucket = new s3.Bucket(this, 'TestBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
    });

    // Deploy assets to the bucket (Lambda will run in VPC)
    new s3deploy.BucketDeployment(this, 'DeployAssets', {
      sources: [s3deploy.Source.asset('./assets')],
      destinationBucket: bucket,
      vpc: sharedVpc.vpc,
      vpcSubnets: sharedVpc.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      }),
      securityGroups: [securityGroup],
    });

    // Output the bucket name
    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'Name of the S3 bucket',
    });

    // Output VPC ID for reference
    new cdk.CfnOutput(this, 'VpcId', {
      value: sharedVpc.vpc.vpcId,
      description: 'Shared VPC ID',
    });
  }
}
