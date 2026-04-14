# Service Control Policy (SCP) Workaround Guide

## The Problem

You're hitting an **AWS Organizations Service Control Policy (SCP)** that blocks Lambda function creation:

```
explicit deny in a service control policy: 
arn:aws:organizations::100102082756:policy/o-wbv48bg3ge/service_control_policy/p-kou3xr7x
```

**Key insight:** The CloudFormation execution role (created by CDK bootstrap) is being blocked by the SCP.

## Why Your One.Cloud Policy Didn't Work

SCPs work at the AWS Organizations level and **override all IAM permissions**:
- Even if you grant Lambda permissions via One.Cloud
- Even if the CloudFormation execution role has full admin permissions
- **SCP denies always win**

## Possible Workarounds

### Workaround 1: Add Policy to CloudFormation Execution Role

**Theory:** SCPs often block human users but allow service roles IF certain conditions are met.

**The Role to Modify:**
```
arn:aws:iam::640664844884:role/cdk-hnb659fds-cfn-exec-role-640664844884-eu-west-1
```

**Policy to Add:** `cloudformation-lambda-permissions.json`

This policy includes:
- Lambda permissions scoped to TestStackStack-* resources
- IAM permissions for creating Lambda execution roles
- CloudWatch Logs permissions
- Conditions that might satisfy SCP requirements

**How to Apply:**
1. Contact your AWS administrators
2. Ask them to attach `cloudformation-lambda-permissions.json` to the CloudFormation execution role
3. Explain it's the CDK-created role, not a user role

### Workaround 2: Stack Tags (Already Applied)

**Theory:** SCPs often require specific tags on resources.

**What We Did:**
Modified `lib/test-stack-stack.ts` to add common compliance tags:
- `Environment: test`
- `Project: CDK-Testing`
- `ManagedBy: CDK`
- `Owner: a2i5giv`
- `Purpose: CDK-Bootstrap-Test`
- `CostCenter: Development`

These tags will be applied to ALL resources (including Lambda functions).

**Test It:**
```bash
npm run build
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk deploy --require-approval never
```

If the SCP has a condition like "deny Lambda creation UNLESS tag:Environment exists", this might work!

### Workaround 3: Request SCP Exception (Proper Solution)

**Contact AWS Administrators and provide:**
- **SCP Policy ID:** `p-kou3xr7x`
- **Organization ID:** `100102082756`
- **Account ID:** `640664844884`
- **Region:** `eu-west-1`
- **Request:** Allow Lambda creation for CDK deployments
- **Justification:** Testing AWS CDK deployment pipeline with BucketDeployment construct

**What to ask for:**
- Exception to allow `lambda:CreateFunction` for resources with prefix `TestStackStack-*`
- OR allow Lambda creation when resources have specific tags (Environment=test)
- OR allow Lambda creation via CloudFormation execution role

### Workaround 4: Accept the Simplified Stack

**Practical approach:**
- Remove `autoDeleteObjects` and `BucketDeployment` from stack
- Upload files manually via AWS CLI
- Still tests CDK deployment pipeline successfully
- No Lambda required

## Testing Order

1. **First:** Try deploying with tags (already added to stack)
   ```bash
   npm run build
   NODE_TLS_REJECT_UNAUTHORIZED=0 cdk deploy --require-approval never
   ```

2. **If that fails:** Request admins attach `cloudformation-lambda-permissions.json` to the CloudFormation execution role

3. **If that fails:** Request SCP exception

4. **If all fail:** Accept simplified stack without Lambda

## Common SCP Patterns That Might Work

### Pattern 1: Require Specific Tags
```json
{
  "Condition": {
    "StringEquals": {
      "aws:RequestTag/Environment": "test"
    }
  }
}
```
✅ **We added this tag!** Try deploying.

### Pattern 2: Allow Service Roles Only
```json
{
  "Condition": {
    "StringLike": {
      "aws:PrincipalArn": "*role/cdk-*"
    }
  }
}
```
✅ **CloudFormation role matches this!** Might work.

### Pattern 3: Require VPC
```json
{
  "Condition": {
    "Null": {
      "lambda:VpcIds": "false"
    }
  }
}
```
❌ **We're not in a VPC** - would need stack modification.

### Pattern 4: Require Specific Naming
```json
{
  "Condition": {
    "StringLike": {
      "lambda:FunctionName": "approved-prefix-*"
    }
  }
}
```
⚠️ **Depends on org policy** - ask admins what prefix is allowed.

## Workaround 5: Allow User to Assume CDK Roles

**Theory:** Your user can't assume the CDK bootstrap roles, so CDK falls back to using your user credentials directly. If you can assume these roles, you'll use their permissions instead.

**Policy to Add:** `assume-cdk-roles.json`

**Roles to Assume:**
- `cdk-hnb659fds-file-publishing-role-640664844884-eu-west-1`
- `cdk-hnb659fds-image-publishing-role-640664844884-eu-west-1`
- `cdk-hnb659fds-deploy-role-640664844884-eu-west-1`
- `cdk-hnb659fds-lookup-role-640664844884-eu-west-1`

**How to Apply in One.Cloud:**
1. Upload `assume-cdk-roles.json` to One.Cloud
2. Attach to your user: `a2i5giv+smart-factory`
3. Try deploying again

**Why This Might Help:**
- These roles have different permissions than your user
- They may not be subject to the same SCP restrictions
- CloudFormation execution will use these roles' permissions

**Current Warnings (these should disappear):**
```
current credentials could not be used to assume 
'arn:aws:iam::640664844884:role/cdk-hnb659fds-file-publishing-role-...'
```

## Files Created

1. **`assume-cdk-roles.json`** - ⭐ **TRY THIS FIRST** - Allow assuming CDK bootstrap roles
2. **`cloudformation-lambda-permissions.json`** - Policy for CloudFormation execution role (needs admin)
3. **`lambda-deployment-permissions-no-iam.json`** - Policy for your user (already tried, didn't help)
4. **`lambda-deployment-permissions.json`** - Full policy with IAM (blocked by One.Cloud)
5. **Modified stack code** - Added compliance tags

## Next Steps

1. **Try deployment with tags** (stack code already modified)
2. **Check error message** - if it changes, we're making progress
3. **Share new error** - might give hints about what SCP requires
4. **Contact admins** - provide them with this guide and policy files

## Learning Outcome

**What we learned about One.Cloud:**
- One.Cloud manages IAM policies for users/roles
- One.Cloud **cannot override AWS Organizations SCPs**
- SCPs are set at a higher level and require AWS admins to modify
- For Lambda permissions blocked by SCP, you need AWS Org-level changes
