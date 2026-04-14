import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
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

    // Create S3 bucket (without autoDeleteObjects to avoid Lambda)
    const bucket = new s3.Bucket(this, 'TestBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
    });

    // Create Lambda function that writes to S3 (running in VPC)
    const testFunction = new lambda.Function(this, 'TestFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import boto3
import json
from datetime import datetime

s3 = boto3.client('s3')

def handler(event, context):
    bucket_name = event['bucket']
    content = f"Hello from AWS CDK Lambda in VPC!\\nDeployed at: {datetime.utcnow().isoformat()}\\nThis file was written by a Lambda function running in the Shared VPC."

    try:
        s3.put_object(
            Bucket=bucket_name,
            Key='hello.txt',
            Body=content.encode('utf-8'),
            ContentType='text/plain'
        )
        return {
            'statusCode': 200,
            'body': json.dumps(f'Successfully wrote hello.txt to {bucket_name}')
        }
    except Exception as e:
        print(f'Error: {str(e)}')
        raise
`),
      vpc: sharedVpc.vpc,
      vpcSubnets: sharedVpc.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      }),
      securityGroups: [securityGroup],
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      environment: {
        BUCKET_NAME: bucket.bucketName,
      },
    });

    // Grant the Lambda function permission to write to the bucket
    bucket.grantPut(testFunction);

    // Add AWSLambdaVPCAccessExecutionRole managed policy for VPC access
    testFunction.role?.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')
    );

    // Output the bucket name
    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'Name of the S3 bucket',
    });

    // Output Lambda function name
    new cdk.CfnOutput(this, 'FunctionName', {
      value: testFunction.functionName,
      description: 'Name of the test Lambda function',
    });

    // Output VPC ID for reference
    new cdk.CfnOutput(this, 'VpcId', {
      value: sharedVpc.vpc.vpcId,
      description: 'Shared VPC ID',
    });

    // Output invocation command
    new cdk.CfnOutput(this, 'InvokeCommand', {
      value: `aws lambda invoke --function-name ${testFunction.functionName} --payload '{"bucket":"${bucket.bucketName}"}' --region eu-west-1 response.json`,
      description: 'Command to invoke the Lambda function',
    });
  }
}
