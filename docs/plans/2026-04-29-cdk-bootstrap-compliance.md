# CDK Bootstrap Compliance Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Resolve One.Cloud compliance findings by adopting account-setup template pattern with KeyStack + BootstrapStack using customer-managed KMS keys and scoped IAM policies.

**Architecture:** Create KeyStack (ONE_FOR_ALL_STRATEGY KMS key) → BootstrapStack (scoped IAM + KMS-encrypted S3) in both eu-west-1 and us-east-1, then update YouTrackStack to use shared KMS key. Destroy and recreate all infrastructure for clean slate deployment.

**Tech Stack:** AWS CDK, TypeScript, @vwg-community/vws-cdk, CloudFormation, KMS, IAM

---

## Task 1: Document Current State and Prepare for Destruction

**Files:**
- Read: `bin/youtrack-app.ts`
- Read: `lib/youtrack-stack.ts`
- Read: `lib/automation-stack.ts`

**Step 1: Document current stack outputs**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws cloudformation describe-stacks --stack-name YouTrackStack-Local --region eu-west-1 --query 'Stacks[0].Outputs' > docs/backup-stack-outputs.json
```

Expected: JSON file with current instance ID, volume IDs, etc.

**Step 2: Check for any critical data in CloudWatch Logs**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws logs describe-log-groups --region eu-west-1 --log-group-name-prefix /aws/ssm/YouTrack
```

Expected: Log group details (retention already set to 1 year, data will be lost after stack deletion)

**Step 3: Verify no ECR images need preservation**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws ecr list-images --repository-name youtrack --region eu-west-1 2>&1 || echo "No ECR repository found"
```

Expected: Either "RepositoryNotFoundException" or list of images (will need to re-push after recreation)

**Step 4: Commit current state**

Run:
```bash
git add -A
git status
```

Expected: Clean working tree or staged documentation changes only

---

## Task 2: Destroy Existing CDK Infrastructure

**Files:**
- None (destructive AWS operations)

**Step 1: Destroy AutomationStack**

Run:
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk destroy AutomationStack-Local --force
```

Expected: Stack deletion confirmation, EventBridge rules and DLM policy removed

**Step 2: Destroy YouTrackStack**

Run:
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk destroy YouTrackStack-Local --force
```

Expected: Stack deletion confirmation, EC2 instance, EBS volumes, KMS keys, security group removed

**Step 3: Delete CDKToolkit bootstrap stack in eu-west-1**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws cloudformation delete-stack --stack-name CDKToolkit --region eu-west-1
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws cloudformation wait stack-delete-complete --stack-name CDKToolkit --region eu-west-1
```

Expected: Stack deleted, bootstrap S3 bucket and IAM roles removed

**Step 4: Delete CDKToolkit bootstrap stack in us-east-1**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws cloudformation delete-stack --stack-name CDKToolkit --region us-east-1
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws cloudformation wait stack-delete-complete --stack-name CDKToolkit --region us-east-1
```

Expected: Stack deleted

**Step 5: Verify all stacks deleted**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws cloudformation list-stacks --region eu-west-1 --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE --query 'StackSummaries[?StackName==`YouTrackStack-Local` || StackName==`AutomationStack-Local` || StackName==`CDKToolkit`]'
```

Expected: Empty array `[]`

---

## Task 3: Install @vwg-community/vws-cdk Dependency

**Files:**
- Modify: `package.json`

**Step 1: Add @vwg-community/vws-cdk dependency**

Add to `package.json` dependencies:
```json
"@vwg-community/vws-cdk": "^1.0.0"
```

**Step 2: Install dependencies**

Run:
```bash
npm install
```

Expected: Package installed, node_modules updated, package-lock.json updated

**Step 3: Verify installation**

Run:
```bash
npm list @vwg-community/vws-cdk
```

Expected: Shows installed version

**Step 4: Commit dependency**

Run:
```bash
git add package.json package-lock.json
git commit -m "deps: add @vwg-community/vws-cdk for compliant bootstrap"
```

---

## Task 4: Create AddStsActionsToTrustPolicyAspect Utility

**Files:**
- Create: `lib/util/add-sts-actions-to-trust-policy-aspect.ts`

**Step 1: Create util directory**

Run:
```bash
mkdir -p lib/util
```

Expected: Directory created

**Step 2: Write AddStsActionsToTrustPolicyAspect implementation**

Create `lib/util/add-sts-actions-to-trust-policy-aspect.ts`:
```typescript
import { IAspect, CfnResource } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';
import { CfnRole } from 'aws-cdk-lib/aws-iam';

/**
 * CDK Aspect that adds STS actions to all IAM role trust policies.
 * Required for VWS Developer Role to assume CDK-created roles.
 * 
 * Adds: sts:SetSourceIdentity and sts:TagSession
 */
export class AddStsActionsToTrustPolicyAspect implements IAspect {
  public visit(node: IConstruct): void {
    if (node instanceof CfnRole) {
      const assumeRolePolicy = node.assumeRolePolicyDocument as any;
      
      if (assumeRolePolicy && assumeRolePolicy.Statement) {
        const statements = Array.isArray(assumeRolePolicy.Statement)
          ? assumeRolePolicy.Statement
          : [assumeRolePolicy.Statement];

        statements.forEach((statement: any) => {
          if (statement.Action) {
            const actions = Array.isArray(statement.Action)
              ? statement.Action
              : [statement.Action];

            // Add STS actions if not already present
            if (actions.includes('sts:AssumeRole')) {
              const stsActions = ['sts:SetSourceIdentity', 'sts:TagSession'];
              stsActions.forEach(action => {
                if (!actions.includes(action)) {
                  actions.push(action);
                }
              });
              statement.Action = actions;
            }
          }
        });
      }
    }
  }
}
```

**Step 3: Verify TypeScript compiles**

Run:
```bash
npm run build
```

Expected: No compilation errors

**Step 4: Commit utility**

Run:
```bash
git add lib/util/add-sts-actions-to-trust-policy-aspect.ts
git commit -m "feat: add AddStsActionsToTrustPolicyAspect for VWS compliance"
```

---

## Task 5: Create KeyStack

**Files:**
- Create: `lib/stacks/key-stack.ts`

**Step 1: Create stacks directory**

Run:
```bash
mkdir -p lib/stacks
```

Expected: Directory created

**Step 2: Write KeyStack implementation**

Create `lib/stacks/key-stack.ts`:
```typescript
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
```

**Step 3: Verify TypeScript compiles**

Run:
```bash
npm run build
```

Expected: No compilation errors

**Step 4: Commit KeyStack**

Run:
```bash
git add lib/stacks/key-stack.ts
git commit -m "feat: add KeyStack with ONE_FOR_ALL_STRATEGY KMS key"
```

---

## Task 6: Create BootstrapStack

**Files:**
- Create: `lib/stacks/bootstrap-stack.ts`

**Step 1: Write BootstrapStack implementation**

Create `lib/stacks/bootstrap-stack.ts`:
```typescript
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Aspects, CfnInclude } from 'aws-cdk-lib';
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
```

**Step 2: Verify TypeScript compiles**

Run:
```bash
npm run build
```

Expected: No compilation errors

**Step 3: Commit BootstrapStack**

Run:
```bash
git add lib/stacks/bootstrap-stack.ts
git commit -m "feat: add BootstrapStack with scoped IAM and customer-managed KMS"
```

---

## Task 7: Update bin/youtrack-app.ts to Instantiate New Stacks

**Files:**
- Modify: `bin/youtrack-app.ts`

**Step 1: Add imports for new stacks**

Add at top of file after existing imports:
```typescript
import { KeyStack } from '../lib/stacks/key-stack';
import { BootstrapStack } from '../lib/stacks/bootstrap-stack';
```

**Step 2: Instantiate KeyStack and BootstrapStack for both regions**

Replace the existing YouTrackStack and AutomationStack instantiation with:
```typescript
const app = new cdk.App();

const account = '640664844884';
const regions = ['eu-west-1', 'us-east-1'];

// Deploy KeyStack and BootstrapStack in both regions
regions.forEach(region => {
  const keyStack = new KeyStack(app, `KeyStack-Local-${region}`, {
    stackName: `YouTrackKeyStack-Local-${region}`,
    env: { account, region },
  });

  const bootstrapStack = new BootstrapStack(app, `BootstrapStack-Local-${region}`, {
    stackName: `YouTrackBootstrapStack-Local-${region}`,
    env: { account, region },
  });
  bootstrapStack.addDependency(keyStack);
});

// Deploy application stacks in eu-west-1 only
const keyStackEuWest1 = app.node.tryFindChild('KeyStack-Local-eu-west-1') as KeyStack;

const youtrackStack = new YouTrackStack(app, 'YouTrackStack-Local', {
  env: { account, region: 'eu-west-1' },
});
youtrackStack.addDependency(keyStackEuWest1);

// Note: Instance ID will be different after recreation - update after deployment
const automationStack = new AutomationStack(app, 'AutomationStack-Local', {
  env: { account, region: 'eu-west-1' },
  instanceId: 'PLACEHOLDER-UPDATE-AFTER-DEPLOYMENT',
});
automationStack.addDependency(youtrackStack);
```

**Step 3: Verify TypeScript compiles**

Run:
```bash
npm run build
```

Expected: No compilation errors

**Step 4: Commit bin/youtrack-app.ts changes**

Run:
```bash
git add bin/youtrack-app.ts
git commit -m "feat: instantiate KeyStack and BootstrapStack in both regions"
```

---

## Task 8: Update YouTrackStack to Use Shared KMS Key

**Files:**
- Modify: `lib/youtrack-stack.ts`

**Step 1: Add KeyStack import**

Add after existing imports:
```typescript
import { KeyStack, KeyPurpose } from '@vwg-community/vws-cdk';
```

**Step 2: Remove inline KMS key creations**

Delete lines 36-65 (ebsKmsKey and logsKmsKey creation and policy statements).

**Step 3: Add shared KMS key lookup**

Add after SharedVpc import (around line 34):
```typescript
// Lookup shared CICD KMS key from KeyStack
const cicdKey = KeyStack.getKeyFromLookup(this, 'CicdKeyLookup', KeyPurpose.CICD);
```

**Step 4: Update CloudWatch LogGroup to use shared key**

Replace line 70 with:
```typescript
encryptionKey: cicdKey,
```

**Step 5: Find and update EBS volume encryption references**

Search for `ebsKmsKey` references and replace with `cicdKey` (multiple locations in the file).

**Step 6: Verify TypeScript compiles**

Run:
```bash
npm run build
```

Expected: No compilation errors

**Step 7: Commit YouTrackStack changes**

Run:
```bash
git add lib/youtrack-stack.ts
git commit -m "refactor: use shared KMS key from KeyStack in YouTrackStack"
```

---

## Task 9: Update AutomationStack Schedule Comment

**Files:**
- Modify: `lib/automation-stack.ts`

**Step 1: Read automation-stack.ts to find schedule comment**

Run:
```bash
grep -n "8AM" lib/automation-stack.ts || grep -n "schedule" lib/automation-stack.ts
```

Expected: Find line number with "8AM-7PM UTC" comment

**Step 2: Update schedule comment from 8AM to 7AM**

Find comment mentioning "8AM-7PM UTC" and change to "7AM-7PM UTC" (correction - code already uses 07:00).

**Step 3: Verify TypeScript compiles**

Run:
```bash
npm run build
```

Expected: No compilation errors

**Step 4: Commit AutomationStack comment correction**

Run:
```bash
git add lib/automation-stack.ts
git commit -m "docs: correct schedule comment to 7AM-7PM UTC"
```

---

## Task 10: Synthesize and Verify CDK Template

**Files:**
- None (verification step)

**Step 1: Synthesize all stacks**

Run:
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk synth
```

Expected: CloudFormation templates generated in `cdk.out/` for all 6 stacks (2 KeyStacks, 2 BootstrapStacks, YouTrackStack, AutomationStack)

**Step 2: Verify KeyStack template**

Run:
```bash
cat cdk.out/YouTrackKeyStack-Local-eu-west-1.template.json | jq '.Resources | keys'
```

Expected: Shows KMS key resource

**Step 3: Verify BootstrapStack template has scoped policy**

Run:
```bash
cat cdk.out/YouTrackBootstrapStack-Local-eu-west-1.template.json | jq '.Resources | to_entries[] | select(.value.Type == "AWS::IAM::ManagedPolicy")'
```

Expected: Shows CdkBootstrapPolicy resource with scoped permissions

**Step 4: Verify YouTrackStack references KeyStack**

Run:
```bash
cat cdk.out/YouTrackStack-Local.template.json | jq '.Resources | to_entries[] | select(.value.Properties.KmsKeyId != null)'
```

Expected: Shows resources using KMS key from lookup

---

## Task 11: Deploy KeyStack and BootstrapStack in eu-west-1

**Files:**
- None (deployment step)

**Step 1: Deploy KeyStack in eu-west-1**

Run:
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk deploy KeyStack-Local-eu-west-1 --require-approval never
```

Expected: Stack deployment success, KMS key created with alias `alias/youtrack-cicd`

**Step 2: Verify KMS key created**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws kms list-aliases --region eu-west-1 --query 'Aliases[?AliasName==`alias/youtrack-cicd`]'
```

Expected: Shows KMS key alias and key ID

**Step 3: Deploy BootstrapStack in eu-west-1**

Run:
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk deploy BootstrapStack-Local-eu-west-1
```

Expected: Stack deployment success, bootstrap S3 bucket and IAM role created with scoped policy

**Step 4: Verify bootstrap S3 bucket encryption**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws s3api get-bucket-encryption --bucket cdk-hnb659fds-assets-640664844884-eu-west-1 --region eu-west-1
```

Expected: Shows customer-managed KMS key ARN (not aws:kms)

**Step 5: Verify CFN execution role uses scoped policy**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws iam list-attached-role-policies --role-name cdk-hnb659fds-cfn-exec-role-640664844884-eu-west-1 --region eu-west-1
```

Expected: Shows `CdkBootstrap-hnb659fds-eu-west-1` (NOT AdministratorAccess)

---

## Task 12: Deploy KeyStack and BootstrapStack in us-east-1

**Files:**
- None (deployment step)

**Step 1: Deploy KeyStack in us-east-1**

Run:
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk deploy KeyStack-Local-us-east-1 --require-approval never
```

Expected: Stack deployment success

**Step 2: Verify KMS key created**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws kms list-aliases --region us-east-1 --query 'Aliases[?AliasName==`alias/youtrack-cicd`]'
```

Expected: Shows KMS key alias and key ID

**Step 3: Deploy BootstrapStack in us-east-1**

Run:
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk deploy BootstrapStack-Local-us-east-1
```

Expected: Stack deployment success

**Step 4: Verify bootstrap S3 bucket encryption**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws s3api get-bucket-encryption --bucket cdk-hnb659fds-assets-640664844884-us-east-1 --region us-east-1
```

Expected: Shows customer-managed KMS key ARN

**Step 5: Verify CFN execution role uses scoped policy**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws iam list-attached-role-policies --role-name cdk-hnb659fds-cfn-exec-role-640664844884-us-east-1 --region us-east-1
```

Expected: Shows `CdkBootstrap-hnb659fds-us-east-1`

---

## Task 13: Deploy YouTrackStack

**Files:**
- None (deployment step)

**Step 1: Deploy YouTrackStack**

Run:
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk deploy YouTrackStack-Local
```

Expected: Stack deployment success, EC2 instance and EBS volumes created with customer-managed KMS key

**Step 2: Get new instance ID from stack outputs**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws cloudformation describe-stacks --stack-name YouTrackStack-Local --region eu-west-1 --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' --output text
```

Expected: New instance ID (e.g., `i-0abc123def456789`)

**Step 3: Verify EBS volumes use customer-managed KMS key**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws ec2 describe-volumes --filters "Name=tag:Project,Values=YouTrack" --region eu-west-1 --query 'Volumes[*].[VolumeId,KmsKeyId]' --output table
```

Expected: All volumes show customer-managed KMS key ARN (not alias/aws/ebs)

**Step 4: Verify CloudWatch Logs use customer-managed KMS key**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws logs describe-log-groups --log-group-name-prefix /aws/ssm/YouTrack --region eu-west-1 --query 'logGroups[*].[logGroupName,kmsKeyId]' --output table
```

Expected: Log groups show customer-managed KMS key ARN

---

## Task 14: Update AutomationStack with New Instance ID and Deploy

**Files:**
- Modify: `bin/youtrack-app.ts`

**Step 1: Get instance ID from previous task**

From Task 13 Step 2, copy the new instance ID.

**Step 2: Update bin/youtrack-app.ts with new instance ID**

Replace `PLACEHOLDER-UPDATE-AFTER-DEPLOYMENT` in AutomationStack instantiation with actual instance ID from Task 13.

**Step 3: Commit instance ID update**

Run:
```bash
git add bin/youtrack-app.ts
git commit -m "fix: update AutomationStack with new instance ID after recreation"
```

**Step 4: Deploy AutomationStack**

Run:
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk deploy AutomationStack-Local --require-approval never
```

Expected: Stack deployment success, EventBridge rules and DLM policy created

**Step 5: Verify EventBridge start/stop rules created**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws events list-rules --region eu-west-1 --query 'Rules[?contains(Name, `YouTrack`)]'
```

Expected: Shows start rule (cron 0 7 ? * MON-FRI *) and stop rule (cron 0 19 ? * MON-FRI *)

---

## Task 15: Push YouTrack Docker Image to ECR (if repository exists)

**Files:**
- None (Docker operations)

**Step 1: Check if ECR repository exists**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws ecr describe-repositories --repository-names youtrack --region eu-west-1 2>&1
```

Expected: Either repository details or "RepositoryNotFoundException"

**Step 2: If repository exists, authenticate to ECR**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws ecr get-login-password --region eu-west-1 | docker login --username AWS --password-stdin 640664844884.dkr.ecr.eu-west-1.amazonaws.com
```

Expected: "Login Succeeded"

**Step 3: Pull YouTrack image from Docker Hub (if not already cached)**

Run:
```bash
docker pull jetbrains/youtrack:2026.1.12458
```

Expected: Image downloaded or "Image is up to date"

**Step 4: Tag image for ECR**

Run:
```bash
docker tag jetbrains/youtrack:2026.1.12458 640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:2026.1.12458
```

Expected: Tag created

**Step 5: Push image to ECR**

Run:
```bash
docker push 640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:2026.1.12458
```

Expected: Image pushed to ECR

**Note:** If ECR repository doesn't exist, skip this task - YouTrack will need different image source configuration.

---

## Task 16: Start Instance and Verify YouTrack Application

**Files:**
- None (verification step)

**Step 1: Start EC2 instance (if outside business hours)**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws ec2 start-instances --instance-ids <instance-id-from-task-13> --region eu-west-1
```

Expected: Instance state changes to "running"

**Step 2: Wait for instance to be running**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws ec2 wait instance-running --instance-ids <instance-id-from-task-13> --region eu-west-1
```

Expected: Command completes when instance is running

**Step 3: Connect via SSM and verify Docker container**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws ssm start-session --target <instance-id-from-task-13> --region eu-west-1
```

In SSM session:
```bash
docker ps
docker logs <container-id>
```

Expected: YouTrack container running, logs show successful startup

**Step 4: Port forward to access YouTrack UI**

Run (in new terminal):
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws ssm start-session --target <instance-id-from-task-13> --region eu-west-1 --document-name AWS-StartPortForwardingSession --parameters '{"portNumber":["8080"],"localPortNumber":["8484"]}'
```

Expected: Port forwarding active

**Step 5: Access YouTrack UI**

Open browser to `http://localhost:8484`

Expected: YouTrack setup wizard or login page (if already configured)

---

## Task 17: Run Compliance Verification

**Files:**
- None (verification step)

**Step 1: Verify IAM AdministratorAccess policy removed (eu-west-1)**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws iam list-attached-role-policies --role-name cdk-hnb659fds-cfn-exec-role-640664844884-eu-west-1 --region eu-west-1 --query 'AttachedPolicies[?PolicyName==`AdministratorAccess`]'
```

Expected: Empty array `[]` (no AdministratorAccess)

**Step 2: Verify IAM AdministratorAccess policy removed (us-east-1)**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws iam list-attached-role-policies --role-name cdk-hnb659fds-cfn-exec-role-640664844884-us-east-1 --region us-east-1 --query 'AttachedPolicies[?PolicyName==`AdministratorAccess`]'
```

Expected: Empty array `[]`

**Step 3: Verify bootstrap S3 uses customer-managed KMS (eu-west-1)**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws s3api get-bucket-encryption --bucket cdk-hnb659fds-assets-640664844884-eu-west-1 --region eu-west-1 --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault'
```

Expected: Shows `SSEAlgorithm: aws:kms` with customer-managed key ID (not alias/aws/s3)

**Step 4: Verify bootstrap S3 uses customer-managed KMS (us-east-1)**

Run:
```bash
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws s3api get-bucket-encryption --bucket cdk-hnb659fds-assets-640664844884-us-east-1 --region us-east-1 --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault'
```

Expected: Shows customer-managed key ID

**Step 5: Verify all YouTrack resources use customer-managed KMS**

Run:
```bash
# EBS volumes
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws ec2 describe-volumes --filters "Name=tag:Project,Values=YouTrack" --region eu-west-1 --query 'Volumes[*].Encrypted' --output text

# CloudWatch Logs
AWS_CA_BUNDLE="" NODE_TLS_REJECT_UNAUTHORIZED=0 aws logs describe-log-groups --log-group-name-prefix /aws/ssm/YouTrack --region eu-west-1 --query 'logGroups[*].kmsKeyId' --output text
```

Expected: All resources show encryption enabled with customer-managed KMS key ID

---

## Task 18: Update CLAUDE.md Documentation

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update "EC2 Instance Schedule" section**

Change line mentioning "08:00 UTC" to "07:00 UTC" (search for "8AM" and replace with "7AM").

**Step 2: Add KeyStack and BootstrapStack documentation**

Under "## Architecture" section, add:
```markdown
### Bootstrap Infrastructure

**KeyStack** - Customer-managed KMS keys
- Uses ONE_FOR_ALL_STRATEGY (single key for all purposes)
- Alias: `alias/youtrack-cicd`
- Purpose: CICD (bootstrap S3), EBS encryption, ECR encryption, CloudWatch Logs encryption
- Automatic key rotation: Enabled (annual)
- Deployed in: eu-west-1, us-east-1

**BootstrapStack** - Compliant CDK bootstrap
- Uses BootstraplessSynthesizer (prevents circular dependency)
- Scoped IAM policy replaces AdministratorAccess: `CdkBootstrap-hnb659fds-<region>`
- Bootstrap S3 bucket encrypted with customer-managed KMS key
- Applies AddStsActionsToTrustPolicyAspect for VWS Developer Role support
- Deployed in: eu-west-1, us-east-1
```

**Step 3: Update deployment commands section**

Under "## Development Commands", update CDK deployment section:
```markdown
**Deploy all stacks:**
```bash
cdk deploy KeyStack-Local-eu-west-1 KeyStack-Local-us-east-1 BootstrapStack-Local-eu-west-1 BootstrapStack-Local-us-east-1 YouTrackStack-Local AutomationStack-Local
```

**Deploy individual stack:**
```bash
cdk deploy YouTrackStack-Local
```
```

**Step 4: Add KMS key information to security section**

Under "## Security Compliance", add:
```markdown
**KMS Key Strategy:**
- ONE_FOR_ALL_STRATEGY: Single customer-managed key per region
- Key alias: `alias/youtrack-cicd`
- Used for: Bootstrap S3 buckets, EBS volumes, CloudWatch Logs
- Cost: $1/month per region ($2/month total for eu-west-1 + us-east-1)
```

**Step 5: Commit CLAUDE.md updates**

Run:
```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with KeyStack, BootstrapStack, and 7AM schedule"
```

---

## Task 19: Final Verification and Cleanup

**Files:**
- None (verification step)

**Step 1: Run CDK diff to verify no unexpected changes**

Run:
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk diff
```

Expected: No differences (all stacks up to date)

**Step 2: Verify git status is clean**

Run:
```bash
git status
```

Expected: "nothing to commit, working tree clean"

**Step 3: Create deployment record**

Run:
```bash
echo "Deployment Date: $(date -u +"%Y-%m-%d %H:%M:%S UTC")
Stacks Deployed:
- KeyStack-Local-eu-west-1
- KeyStack-Local-us-east-1
- BootstrapStack-Local-eu-west-1
- BootstrapStack-Local-us-east-1
- YouTrackStack-Local
- AutomationStack-Local

Instance ID: <instance-id-from-task-13>
KMS Key Strategy: ONE_FOR_ALL_STRATEGY
Compliance Status: RESOLVED
- IAM AdministratorAccess: Replaced with scoped policies
- AWS-managed KMS keys: Replaced with customer-managed keys" > docs/deployment-$(date +%Y-%m-%d).md
```

**Step 4: Commit deployment record**

Run:
```bash
git add docs/deployment-*.md
git commit -m "docs: add deployment record for CDK bootstrap compliance remediation"
```

**Step 5: Create summary of changes**

Run:
```bash
git log --oneline --since="1 day ago"
```

Expected: Shows all commits from this implementation

---

## Success Criteria

✅ **Compliance:**
- No IAM AdministratorAccess policy findings in eu-west-1 or us-east-1
- No AWS-managed KMS key findings on bootstrap S3 buckets
- All resources encrypted with customer-managed KMS keys

✅ **Functionality:**
- CDK deployments succeed using new bootstrap infrastructure
- YouTrack application accessible via SSM port forwarding
- Instance scheduling works (start 07:00 UTC, stop 19:00 UTC Mon-Fri)
- EBS snapshots created weekly (Friday 18:00 UTC)

✅ **Code Quality:**
- TypeScript compiles without errors
- All commits follow conventional commit format
- CLAUDE.md documentation updated
- No unnecessary code or inline KMS keys remaining

---

## Rollback Plan

If deployment fails at any step:

1. **Before Task 11:** Re-run `cdk bootstrap` with default settings in both regions
2. **After Task 11:** Check CloudFormation stack events for errors, fix code, redeploy
3. **After Task 13:** If YouTrack fails to start, check UserData script, SSM logs, Docker container logs
4. **Critical failure:** Destroy all new stacks and redeploy with inline KMS keys (revert to pre-implementation state)

---

## Notes

- Schedule operates on UTC time: 07:00 UTC = 7AM WET / 8AM WEST
- Qualifier `hnb659fds` maintained for compatibility
- @vwg-community/vws-cdk provides KeyStack, KeyStrategies, BootstraplessSynthesizer
- AddStsActionsToTrustPolicyAspect required per VWS compliance
- ONE_FOR_ALL_STRATEGY: cost-efficient ($1/month per key vs $4/month for 4 separate keys)
