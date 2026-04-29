# Pre-Destruction State Documentation

**Date**: 2026-04-29
**Purpose**: Document current infrastructure state before CDK Bootstrap Compliance Remediation

## Overview

This document captures the state of the YouTrack infrastructure before destroying and recreating all CDK stacks to adopt compliant bootstrap patterns.

## Current Stack Configuration

### Stacks Deployed
1. **YouTrackStack-Local** (eu-west-1)
2. **AutomationStack-Local** (eu-west-1)
3. **EcrStack-Local** (NOT currently deployed - ECR repository exists separately)

### YouTrackStack-Local Outputs

- **Instance ID**: i-0535d4cb73b266680
- **Private IP**: 192.168.148.21
- **Access URL**: http://192.168.148.21:8080
- **VPC ID**: vpc-05b5078f709cfc904
- **KMS Key ID**: e70778f4-cced-4312-a192-03cbfdf5c4e0
- **KMS Key ARN**: arn:aws:kms:eu-west-1:640664844884:key/e70778f4-cced-4312-a192-03cbfdf5c4e0
- **SSM Connect**: aws ssm start-session --target i-0535d4cb73b266680 --region eu-west-1

### AutomationStack-Local Outputs

- **Instance ID**: i-0535d4cb73b266680
- **Start Schedule ARN**: arn:aws:scheduler:eu-west-1:640664844884:schedule/default/youtrack-start-schedule
- **Stop Schedule ARN**: arn:aws:scheduler:eu-west-1:640664844884:schedule/default/youtrack-stop-schedule
- **DLM Policy ARN**: arn:aws:dlm:eu-west-1:640664844884:policy/policy-051fac74bd53cc579
- **Schedule**: Mon-Fri: Start at 08:00 UTC, Stop at 19:00 UTC
- **Backup**: Weekly snapshots on Friday at 19:30 UTC, retaining 4 snapshots

## Critical Resources

### EC2 Instance
- **Instance ID**: i-0535d4cb73b266680
- **Instance Type**: t3.medium
- **AMI**: ami-0b434d403262ef6c7 (Amazon Linux 2 from One.Cloud image factory)
- **Availability Zone**: eu-west-1a
- **Private IP**: 192.168.148.21
- **IMDSv2**: Enforced

### EBS Data Volume
- **Volume ID**: vol-0e7e1438ea17e20ac
- **Size**: 50GB gp3
- **Encrypted**: Yes
- **KMS Key**: arn:aws:kms:eu-west-1:640664844884:key/e70778f4-cced-4312-a192-03cbfdf5c4e0
- **Device**: /dev/sdf
- **Mount Point**: /var/youtrack-data
- **Attached To**: i-0535d4cb73b266680
- **Delete On Termination**: false
- **Backup Tag**: weekly-dlm
- **State**: in-use

### KMS Keys

#### EBS Encryption Key
- **Key ID**: e70778f4-cced-4312-a192-03cbfdf5c4e0
- **ARN**: arn:aws:kms:eu-west-1:640664844884:key/e70778f4-cced-4312-a192-03cbfdf5c4e0
- **Alias**: alias/youtrack-ebs-encryption
- **Description**: Customer-managed key for YouTrack EBS encryption (VW-controlled)
- **State**: Enabled
- **Key Rotation**: Enabled
- **Creation Date**: 2026-04-28

#### Logs Encryption Key
- **Expected Alias**: alias/youtrack-logs-encryption
- **Description**: Customer-managed key for YouTrack CloudWatch Logs encryption
- **Note**: This key exists in the stack but was not explicitly queried

### EBS Snapshots

**Total Snapshots Found**: 3 (with Backup: weekly-dlm tag)

1. **snap-0d223cfa8daa5063c**
   - Start Time: 2026-04-28T08:40:23.155000+00:00
   - Volume Size: 50GB
   - State: completed
   - KMS Key: arn:aws:kms:eu-west-1:640664844884:key/0d882071-1cf4-41ab-a994-1fa8b119400d

2. **snap-0fa89856719cf82a6**
   - Start Time: 2026-04-28T08:45:26.754000+00:00
   - Volume Size: 50GB
   - State: completed
   - KMS Key: arn:aws:kms:eu-west-1:640664844884:key/2acd66c3-6ab5-48dd-9bd1-e7d8ed0fca2e

3. **snap-0e3693731a434df91**
   - Start Time: 2026-04-28T14:38:18.470000+00:00
   - Volume Size: 50GB
   - State: completed
   - KMS Key: arn:aws:kms:eu-west-1:640664844884:key/99592e25-cafa-4a3d-a425-7af96f7aef7b

**Note**: These snapshots are from previous volume iterations. The current volume (vol-0e7e1438ea17e20ac) was created on 2026-04-28T15:02:57.919000+00:00.

### ECR Repository

**Repository**: youtrack
**Region**: eu-west-1
**Account**: 640664844884
**Full URI**: 640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack

**Images**:
- **Tag**: 2026.1.12458
- **Digest**: sha256:ed55f3fdcc215a794994b10afc33504dd14e901de8210c01f1bbcc992ed5d456

**Status**: Repository exists independently of EcrStack-Local (stack not currently deployed)

### CloudWatch Logs

**Log Group**: /aws/ssm/YouTrack
**Status**: No log groups found with this prefix
**Note**: Log group may not have been created yet or may use a different naming pattern

## Stack Configuration Files

### bin/youtrack-app.ts
- Defines YouTrackStack-Local and AutomationStack-Local
- Account: 640664844884
- Region: eu-west-1
- Hardcoded instance ID in AutomationStack: i-0535d4cb73b266680

### lib/youtrack-stack.ts
- Uses SharedVpc from @vwg-community/vws-cdk
- Creates customer-managed KMS keys for EBS and Logs
- Deploys t3.medium EC2 instance
- Attaches 50GB encrypted data volume at /dev/sdf
- Security group allows port 8080 from RFC 1918 ranges
- UserData installs Docker and runs YouTrack from ECR
- YouTrack version: 2026.1.12458

### lib/automation-stack.ts
- EventBridge Scheduler for start/stop (Mon-Fri 8AM-7PM UTC)
- DLM lifecycle policy for weekly snapshots
- Requires instanceId prop (no CustomResource due to Lambda SCP)

## Data Preservation Strategy

### Critical Data Volume
The EBS data volume (vol-0e7e1438ea17e20ac) contains:
- `/var/youtrack-data/data` - YouTrack database
- `/var/youtrack-data/conf` - Configuration files
- `/var/youtrack-data/logs` - Application logs
- `/var/youtrack-data/backups` - Internal backups

### Volume Retention
- **RemovalPolicy**: SNAPSHOT (CDK will create snapshot on stack deletion)
- **Delete On Termination**: false (volume survives instance termination)
- **Backup Tag**: weekly-dlm (DLM will continue creating snapshots)

### Recovery Plan
1. Before destroying YouTrackStack-Local:
   - Stop instance (to ensure clean filesystem state)
   - Create manual snapshot of vol-0e7e1438ea17e20ac
   - Tag snapshot with clear identifier for recovery

2. After destroying YouTrackStack-Local:
   - Volume will be deleted, but snapshot will be retained
   - Snapshot can be used to recreate volume in new stack

3. In new YouTrackStack:
   - Create volume from snapshot
   - Attach to new instance
   - UserData will skip formatting (blkid detects existing filesystem)
   - Mount and verify data integrity

## Security Configuration

### Network Isolation
- No public IP
- Private VPC (vpc-05b5078f709cfc904)
- PRIVATE_ISOLATED subnets
- Security group: RFC 1918 ingress on port 8080

### Access Control
- SSM Session Manager only (no SSH)
- IMDSv2 enforced
- IAM role: AmazonSSMManagedInstanceCore + ECR read

### Encryption
- EBS volumes: Customer-managed KMS key
- CloudWatch Logs: Customer-managed KMS key
- ECR: Encryption at rest (default AWS-managed)
- KMS key rotation: Enabled

### Compliance Tags
- Environment: production
- Project: YouTrack
- ManagedBy: CDK
- Owner: a2i5giv
- Purpose: Issue-Tracking

## Dependencies

### NPM Packages
- aws-cdk-lib: ^2.174.3
- @vwg-community/vws-cdk: Required for SharedVpc
- constructs: ^10.0.0

### AWS Services
- EC2 (t3.medium instance)
- EBS (50GB gp3 volumes)
- KMS (customer-managed keys)
- ECR (Docker image repository)
- IAM (roles and policies)
- SSM (Session Manager)
- EventBridge Scheduler (start/stop automation)
- DLM (snapshot lifecycle)
- CloudWatch Logs (session logs)

## Risks and Mitigations

### Risk 1: Data Loss
- **Risk**: Destroying stack could delete data volume
- **Mitigation**: 
  - RemovalPolicy: SNAPSHOT configured
  - Create manual snapshot before destruction
  - Verify snapshots exist before proceeding

### Risk 2: KMS Key Deletion
- **Risk**: KMS keys might be scheduled for deletion
- **Mitigation**:
  - RemovalPolicy: RETAIN configured
  - Keys will not be deleted
  - Can be reused in new stacks

### Risk 3: Instance ID Hardcoding
- **Risk**: AutomationStack has hardcoded instance ID
- **Mitigation**:
  - New instance will have different ID
  - Must update bin/youtrack-app.ts after deployment
  - Redeploy AutomationStack with new ID

### Risk 4: Network Configuration Changes
- **Risk**: New stack might deploy to different subnet/AZ
- **Mitigation**:
  - Document current subnet selection logic
  - Use same SharedVpc construct
  - Verify private IP assignment after deployment

## Next Steps

### Before Destruction
1. Stop EC2 instance (clean shutdown)
2. Create manual snapshot of data volume
3. Export stack templates (cdk synth)
4. Document any custom configurations
5. Verify git commit includes all changes

### During Destruction
1. Destroy AutomationStack-Local first (no dependencies)
2. Destroy YouTrackStack-Local second
3. Verify KMS keys are retained
4. Verify snapshot was created
5. Do NOT destroy ECR repository (images needed)

### After Destruction
1. Verify retained resources (KMS keys, snapshots, ECR)
2. Clean up orphaned resources if any
3. Proceed with KeyStack and BootstrapStack creation
4. Deploy new YouTrackStack with compliance patterns
5. Update AutomationStack with new instance ID

## Verification Commands

```bash
# Check instance state
aws ec2 describe-instances --instance-ids i-0535d4cb73b266680 --region eu-west-1

# Check data volume
aws ec2 describe-volumes --volume-ids vol-0e7e1438ea17e20ac --region eu-west-1

# Check snapshots
aws ec2 describe-snapshots --owner-ids 640664844884 --region eu-west-1 \
  --filters "Name=tag:Backup,Values=weekly-dlm"

# Check KMS keys
aws kms describe-key --key-id e70778f4-cced-4312-a192-03cbfdf5c4e0 --region eu-west-1

# Check ECR images
aws ecr list-images --repository-name youtrack --region eu-west-1

# Check stacks
aws cloudformation describe-stacks --region eu-west-1
```

## Backup Files Generated

All backup files are stored in `docs/` directory:
- `backup-stack-outputs.json` - YouTrackStack-Local outputs
- `backup-automation-outputs.json` - AutomationStack-Local outputs
- `backup-ebs-volumes.json` - Current data volume details
- `backup-snapshots.json` - Existing snapshots with weekly-dlm tag
- `backup-kms-key.json` - EBS KMS key metadata
- `pre-destruction-state.md` - This comprehensive documentation
