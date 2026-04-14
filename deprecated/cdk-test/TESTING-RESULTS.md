# AWS CDK Testing Results

## ✅ Mission Accomplished

Successfully deployed AWS CDK stack with Lambda function running in VWS Shared VPC, satisfying One.Cloud SCP requirements.

## Project Goals - All Achieved

1. ✅ **Bootstrap AWS CDK** in fresh account (eu-west-1)
2. ✅ **Deploy test stack** with S3 bucket
3. ✅ **Deploy Lambda function** that writes to S3
4. ✅ **Learn One.Cloud** permission system and SCP constraints
5. ✅ **Configure VWG CDK** with Shared VPC

## Final Deployment

**Stack:** `TestStackStack`  
**Region:** `eu-west-1`  
**Account:** `640664844884`

### Resources Created

| Resource | ID | Purpose |
|----------|-----|---------|
| VPC | `vpc-05b5078f709cfc904` | VWS Shared VPC for Lambda |
| Security Group | `LambdaSecurityGroup0BD9FC99` | Lambda network access |
| S3 Bucket | `teststackstack-testbucket560b80bc-g32vmhfg9gbc` | Test storage |
| Lambda Function | `TestStackStack-TestFunction22AD90FC-Guxoonu75Lbq` | Writes to S3 |
| IAM Role | `TestFunctionServiceRole6ABD93C7` | Lambda execution role |

### Test Verification

```bash
# Lambda invocation
aws lambda invoke --function-name TestStackStack-TestFunction22AD90FC-Guxoonu75Lbq \
  --cli-binary-format raw-in-base64-out \
  --payload '{"bucket":"teststackstack-testbucket560b80bc-g32vmhfg9gbc"}' \
  --region eu-west-1 response.json

# Result: StatusCode 200

# File verification
aws s3 cp s3://teststackstack-testbucket560b80bc-g32vmhfg9gbc/hello.txt -

# Output:
# Hello from AWS CDK Lambda in VPC!
# Deployed at: 2026-04-14T15:26:28.073799
# This file was written by a Lambda function running in the Shared VPC.
```

## Key Challenges Overcome

### 1. Service Control Policy (SCP) Restrictions

**Problem:** AWS Organizations SCP blocks Lambda creation outside VPC  
**Error:** `explicit deny in a service control policy: p-kou3xr7x`

**Solution:** Configure all Lambda functions with VpcConfig pointing to VWS Shared VPC

### 2. VWG CDK Package Authentication

**Problem:** `@vwg-community/vws-cdk` not available on public npm registry  
**Solution:** Configure AWS CodeArtifact authentication
```bash
aws codeartifact get-authorization-token \
  --domain vwg-community \
  --domain-owner 565220512126 \
  --region eu-west-1
```

### 3. CDK Construct Limitations

**Problem:** `BucketDeployment` and `autoDeleteObjects` create Lambda functions without VPC configuration  
**Solution:** Created standalone Lambda function with explicit VPC settings instead of using convenience constructs

### 4. SSL Certificate Issues

**Problem:** Zscaler proxy causing SSL verification failures  
**Solution:** Temporarily disable verification with `NODE_TLS_REJECT_UNAUTHORIZED=0` and configure Zscaler CA bundle

## Technology Stack

- **AWS CDK**: 2.1118.0
- **Language**: TypeScript
- **VWG CDK**: Latest from CodeArtifact
- **Lambda Runtime**: Python 3.9
- **VPC Type**: VWS Shared VPC (PRIVATE_ISOLATED subnets)

## Architectural Decisions

### Why Standalone Lambda Instead of BucketDeployment?

**BucketDeployment Limitation:**  
The CDK `BucketDeployment` construct creates Lambda functions internally but doesn't expose VPC configuration options. These auto-generated Lambdas are blocked by the SCP.

**Our Solution:**  
Created an explicit Lambda function with full VPC configuration:
- Explicitly set `vpc`, `vpcSubnets`, and `securityGroups`
- Added `AWSLambdaVPCAccessExecutionRole` managed policy
- Lambda invoked manually to write to S3

### Why No autoDeleteObjects?

The `autoDeleteObjects: true` feature creates a custom resource Lambda function that also lacks VPC configuration. For a test stack, manual cleanup is acceptable.

## One.Cloud Learnings

### Permission Layers

1. **IAM Policies** (One.Cloud manages these)
   - User/role-level permissions
   - Applied via One.Cloud dashboard
   - Example: `assume-cdk-roles.json`, `lambda-deployment-permissions.json`

2. **Service Control Policies** (Organization-level)
   - Override IAM policies
   - Require AWS admin intervention
   - Cannot be modified via One.Cloud

### VWS Shared VPC

- Activated via One.Cloud dashboard
- Creates CloudFormation resource type: `VWS::VPC::Shared`
- Provides managed VPC with PRIVATE_ISOLATED subnets
- Required for Lambda deployment under One.Cloud SCP

## Commands Reference

### Deploy Stack
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk deploy --require-approval never
```

### Invoke Lambda
```bash
aws lambda invoke \
  --function-name <FUNCTION-NAME> \
  --cli-binary-format raw-in-base64-out \
  --payload '{"bucket":"<BUCKET-NAME>"}' \
  --region eu-west-1 \
  response.json
```

### Verify File in S3
```bash
aws s3 ls s3://<BUCKET-NAME>/ --region eu-west-1
aws s3 cp s3://<BUCKET-NAME>/hello.txt - --region eu-west-1
```

### Destroy Stack
```bash
# First, empty the bucket (no autoDeleteObjects)
aws s3 rm s3://<BUCKET-NAME>/hello.txt --region eu-west-1

# Then destroy the stack
cdk destroy
```

## Files Created

### Policies (for documentation)
- `policies/assume-cdk-roles.json` - Allow assuming CDK bootstrap roles
- `policies/lambda-deployment-permissions-no-iam.json` - Lambda permissions (no IAM)
- `policies/cloudformation-lambda-permissions.json` - For CFN execution role
- `policies/SCP-WORKAROUND-GUIDE.md` - Complete troubleshooting guide

### Code
- `lib/test-stack-stack.ts` - CDK stack with VPC Lambda
- `bin/test-stack.ts` - CDK app entry point
- `assets/hello.txt` - Original test file (not used in final version)

### Configuration
- `.npmrc` - CodeArtifact authentication
- `cdk.context.json` - CDK context cache

## Cleanup Instructions

```bash
# 1. Delete file from S3
aws s3 rm s3://teststackstack-testbucket560b80bc-g32vmhfg9gbc/hello.txt --region eu-west-1

# 2. Destroy CDK stack
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk destroy --force

# 3. (Optional) Remove CDK bootstrap stack if no other projects need it
aws cloudformation delete-stack --stack-name CDKToolkit --region eu-west-1
```

## Success Metrics

| Metric | Target | Achieved |
|--------|--------|----------|
| CDK Bootstrap | Complete | ✅ Yes |
| Stack Deployment | Success | ✅ Yes |
| Lambda in VPC | Running | ✅ Yes |
| S3 Write Test | Working | ✅ Yes |
| SCP Compliance | Satisfied | ✅ Yes |
| One.Cloud Knowledge | Gained | ✅ Yes |

## Conclusion

Successfully validated the complete AWS CDK deployment pipeline in One.Cloud environment with SCP constraints. Demonstrated:

1. CDK infrastructure as code works in One.Cloud
2. Lambda functions can be deployed with VPC requirements
3. Integration between Lambda and S3 functions correctly
4. VWG community CDK tooling is accessible and functional

This project serves as a foundation for future CDK deployments in the One.Cloud environment.
