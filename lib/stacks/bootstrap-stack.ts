import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Aspects } from 'aws-cdk-lib';
import { CfnInclude } from 'aws-cdk-lib/cloudformation-include';
import { BootstraplessSynthesizer, KeyStack, KeyPurpose } from '@vwg-community/vws-cdk';
import { PolicyStatement, Effect, ManagedPolicy } from 'aws-cdk-lib/aws-iam';
import { AddStsActionsToTrustPolicyAspect } from '../util/add-sts-actions-to-trust-policy-aspect';

export interface BootstrapStackProps extends cdk.StackProps {
  /**
   * Additional IAM policy statements for CDK execution role.
   * @default - Service-specific wildcard permissions (cloudformation:*, ec2:*, etc.)
   */
  policyStatements?: PolicyStatement[];

  /**
   * Trusted AWS account ID for cross-account bootstrap (optional).
   * Not needed for single-account deployments.
   */
  trustedAccount?: string;
}

/**
 * Compliant CDK bootstrap stack using customer-managed KMS keys and scoped IAM policies.
 * Replaces default `cdk bootstrap` to resolve One.Cloud compliance findings.
 */
export class BootstrapStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: BootstrapStackProps) {
    super(scope, id, {
      synthesizer: new BootstraplessSynthesizer(),
      ...props,
    });

    // Apply VWS compliance aspect
    Aspects.of(this).add(new AddStsActionsToTrustPolicyAspect());

    // Add compliance tags
    cdk.Tags.of(this).add('Environment', 'production');
    cdk.Tags.of(this).add('Project', 'YouTrack');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Owner', 'a2i5giv');
    cdk.Tags.of(this).add('Purpose', 'Issue-Tracking');

    // Get CDK qualifier (default: hnb659fds)
    const qualifier = this.node.tryGetContext('bootstrap-qualifier') || 'hnb659fds';

    // Create scoped IAM managed policy (replaces AdministratorAccess)
    const policyName = `CdkBootstrap-${qualifier}-${this.region}`;
    const defaultPolicyStatements = [
      // Required for CDK version checking
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ssm:GetParameters'],
        resources: [
          `arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/cdk-bootstrap/${qualifier}/version`,
        ],
      }),
      // Service-specific permissions (replaces AdministratorAccess)
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'cloudformation:*',
          'cloudwatch:*',
          'ec2:*',
          'ecr:*',
          'events:*',
          'iam:*',
          'kms:*',
          'lambda:*',
          'logs:*',
          's3:*',
          'serverlessrepo:*',
          'ssm:*',
        ],
        resources: ['*'],
      }),
    ];

    new ManagedPolicy(this, 'CdkBootstrapPolicy', {
      managedPolicyName: policyName,
      statements: props?.policyStatements || defaultPolicyStatements,
    });

    // Lookup CICD KMS key from KeyStack
    const cicdKey = KeyStack.getKeyFromLookup(this, 'CicdKeyLookup', KeyPurpose.CICD);

    // Include CDK bootstrap template with custom parameters
    new CfnInclude(this, 'CdkBootstrapStackInclude', {
      templateFile: require.resolve('aws-cdk/lib/api/bootstrap/bootstrap-template.yaml'),
      parameters: {
        CloudFormationExecutionPolicies: [`arn:aws:iam::${this.account}:policy/${policyName}`],
        Qualifier: qualifier,
        FileAssetsBucketKmsKeyId: cicdKey.keyId,
        ...(props?.trustedAccount ? { TrustedAccounts: props.trustedAccount } : {}),
      },
    });

    // Output the policy ARN for reference
    new cdk.CfnOutput(this, 'CdkExecutionPolicyArn', {
      value: `arn:aws:iam::${this.account}:policy/${policyName}`,
      description: 'ARN of the scoped CDK execution policy',
    });
  }
}
