# Lambda Deployment Permissions for CDK

## Overview

This policy grants the necessary permissions to deploy AWS CDK stacks that use Lambda functions, specifically for the CDK `BucketDeployment` construct which requires Lambda to upload assets to S3 buckets.

## Background

The AWS CDK `BucketDeployment` construct uses a Lambda function behind the scenes to:
1. Download assets from the CDK staging bucket
2. Upload them to your target S3 bucket
3. Clean up old files if configured

Without Lambda permissions, CDK deployments fail with:
```
AccessDenied: User is not authorized to perform: lambda:CreateFunction
```

## Policy File

**File:** `lambda-deployment-permissions.json`

**Account ID:** 640664844884  
**Region:** eu-west-1  
**Stack Prefix:** TestStackStack / teststackstack

## Permissions Included

### 1. Lambda Function Management
- Create, update, delete Lambda functions
- Invoke functions (needed for BucketDeployment)
- Manage function permissions and tags
- **Scope:** Only functions with prefix `TestStackStack-*` or `teststackstack-*`

### 2. Lambda Layer Management
- Get and publish Lambda layers (CDK uses AWS CLI layer for BucketDeployment)
- **Scope:** All layers in the account/region

### 3. IAM Role Management
- Create and manage Lambda execution roles
- Pass roles to Lambda service
- Attach policies to roles
- **Scope:** Only roles with prefix `TestStackStack-*` or `teststackstack-*`

### 4. CloudWatch Logs
- Create log groups and streams for Lambda function logs
- Write logs (Lambda needs this for debugging)
- **Scope:** Only log groups for TestStackStack Lambda functions

### 5. S3 Access
- Read/write access to the test stack S3 buckets
- Access to CDK staging bucket (where assets are stored)
- **Scope:** Only buckets with prefix `teststackstack-*` and CDK toolkit buckets

## How to Apply in One.Cloud

1. **Upload the policy JSON file** to One.Cloud
2. **Select your user:** `a2i5giv+smart-factory` or the appropriate IAM user/role
3. **Attach the policy** to your user or role
4. **Wait for propagation** (usually immediate, but can take up to 5 minutes)
5. **Test deployment** by running `cdk deploy` again

## Security Notes

- **Least Privilege:** Policy is scoped to specific resource prefixes (TestStackStack-*)
- **Region-Specific:** Only applies to eu-west-1 region
- **Account-Specific:** Only applies to account 640664844884
- **Limited Scope:** Does not grant broad Lambda permissions across the account

## Alternative: SCP Exception

If One.Cloud cannot grant these permissions due to Service Control Policy (SCP) restrictions, you may need to:

1. Request an **SCP exception** for your account/organizational unit
2. Have the policy modified to allow Lambda creation for CDK deployments
3. This requires AWS Organizations administrator access

## Verification

After applying the policy, verify permissions with:

```bash
# Test Lambda create permission
aws lambda list-functions --region eu-west-1

# Test IAM role creation (dry run via CDK)
cdk deploy --dry-run
```

If successful, you should see no permission errors.

## Rollback Plan

If these permissions cause issues or are no longer needed:

1. Remove the policy from your user/role in One.Cloud
2. The TestStack stack can be destroyed with: `cdk destroy`
3. Lambda functions and roles will be automatically cleaned up

## Support

If you encounter issues applying this policy in One.Cloud:
- Contact your cloud platform team
- Reference this documentation
- Provide the error message from the failed `cdk deploy` attempt
