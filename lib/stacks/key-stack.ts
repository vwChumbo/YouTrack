import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { KeyStack as VwsKeyStack, KeyStrategies, KeyPurpose } from '@vwg-community/vws-cdk';

export interface KeyStackProps extends cdk.StackProps {
  // No additional props needed for ONE_FOR_ALL_STRATEGY
}

/**
 * Creates customer-managed KMS keys using ONE_FOR_ALL_STRATEGY.
 * Single key used for CICD (bootstrap S3), EBS, ECR, and CloudWatch Logs.
 */
export class KeyStack extends VwsKeyStack {
  constructor(scope: Construct, id: string, props?: KeyStackProps) {
    super(scope, id, {
      ...props,
      keyStrategy: [KeyStrategies.ONE_FOR_ALL_STRATEGY],
    });

    // Add compliance tags
    cdk.Tags.of(this).add('Environment', 'production');
    cdk.Tags.of(this).add('Project', 'YouTrack');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Owner', 'a2i5giv');
    cdk.Tags.of(this).add('Purpose', 'Issue-Tracking');
  }

  /**
   * Static method to retrieve CICD key from lookup.
   * Use in other stacks: KeyStack.getKeyFromLookup(this, 'CicdKeyLookup', KeyPurpose.CICD)
   */
  public static override getKeyFromLookup(
    scope: Construct,
    id: string,
    keyPurpose: KeyPurpose
  ) {
    return VwsKeyStack.getKeyFromLookup(scope, id, keyPurpose);
  }
}
