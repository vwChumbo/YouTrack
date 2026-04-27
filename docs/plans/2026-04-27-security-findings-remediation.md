# Security Findings Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remediate 4 of 5 One.Cloud Security Hub findings by enabling IMDSv2, implementing customer-managed KMS encryption, and adding ECR security policies.

**Architecture:** Modify existing YouTrackStack to add KMS key resource and configure EC2/EBS for IMDSv2 and customer-managed encryption. Create new EcrStack for ECR lifecycle and immutability policies. Execute one-time manual migration for existing data volume.

**Tech Stack:** AWS CDK (TypeScript), AWS KMS, EC2, EBS, ECR, CloudFormation

---

## Prerequisites

- AWS CDK CLI installed
- AWS credentials configured with KMS, EC2, ECR permissions
- Current branch: `main`
- Working directory: `C:\Users\A2I5GIV\Code\oneCloud`

---

## Task 1: Create KMS Key in YouTrackStack

**Files:**
- Modify: `lib/youtrack-stack.ts:1-10` (imports)
- Modify: `lib/youtrack-stack.ts:15-228` (class body)

**Step 1: Add KMS import**

In `lib/youtrack-stack.ts`, add KMS import after existing imports:

```typescript
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { SharedVpc } from '@vwg-community/vws-cdk';
```

**Step 2: Create KMS key resource**

After line 32 (after SharedVpc instantiation), add KMS key:

```typescript
// Import Shared VPC (required by SCP)
const sharedVpc = new SharedVpc(this, 'SharedVpc');

// Create customer-managed KMS key for EBS encryption
const ebsKmsKey = new kms.Key(this, 'YouTrackEbsKey', {
  description: 'Customer-managed key for YouTrack EBS encryption (VW-controlled)',
  enableKeyRotation: true,
  removalPolicy: cdk.RemovalPolicy.RETAIN,
});

ebsKmsKey.addAlias('alias/youtrack-ebs-encryption');

// Grant EC2 service access for volume encryption
ebsKmsKey.addToResourcePolicy(new iam.PolicyStatement({
  sid: 'Allow EC2 to use the key for volume encryption',
  principals: [new iam.ServicePrincipal('ec2.amazonaws.com')],
  actions: [
    'kms:Decrypt',
    'kms:DescribeKey',
    'kms:CreateGrant',
  ],
  resources: ['*'],
}));

// Grant DLM service access for snapshot encryption
ebsKmsKey.addToResourcePolicy(new iam.PolicyStatement({
  sid: 'Allow DLM to use the key for snapshots',
  principals: [new iam.ServicePrincipal('dlm.amazonaws.com')],
  actions: [
    'kms:Decrypt',
    'kms:Encrypt',
    'kms:DescribeKey',
    'kms:CreateGrant',
  ],
  resources: ['*'],
}));
```

**Step 3: Validate CDK synth**

Run: `cdk synth YouTrackStack-Local`

Expected: CloudFormation template generates successfully with KMS key resource (AWS::KMS::Key) and alias (AWS::KMS::Alias)

**Step 4: Check git diff**

Run: `git diff lib/youtrack-stack.ts`

Expected: Shows KMS import and key resource addition

**Step 5: Commit**

```bash
git add lib/youtrack-stack.ts
git commit -m "feat: add customer-managed KMS key for EBS encryption

- Create KMS key with VW control for compliance
- Enable automatic key rotation (annual)
- Grant EC2 service principal for volume encryption
- Grant DLM service principal for snapshot encryption
- Set RETAIN removal policy to preserve key

Addresses Security Hub finding: Customer-Managed KMS Key (MUST/MEDIUM)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 2: Enable IMDSv2 on EC2 Instance

**Files:**
- Modify: `lib/youtrack-stack.ts:154-177` (EC2 Instance configuration)

**Step 1: Add requireImdsv2 property**

In the `ec2.Instance` constructor (around line 154), add `requireImdsv2: true`:

```typescript
this.instance = new ec2.Instance(this, 'YouTrackInstance', {
  instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
  machineImage: ec2.MachineImage.genericLinux({
    'eu-west-1': 'ami-0b434d403262ef6c7',
  }),
  vpc: sharedVpc.vpc,
  vpcSubnets: {
    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
    availabilityZones: [targetAz],
  },
  availabilityZone: targetAz,
  securityGroup: securityGroup,
  role: instanceRole,
  userData: userData,
  requireImdsv2: true,  // NEW: Enforce IMDSv2
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
```

**Step 2: Validate CDK synth**

Run: `cdk synth YouTrackStack-Local`

Expected: CloudFormation template shows `MetadataOptions.HttpTokens: required` in EC2 instance properties

**Step 3: Check CDK diff**

Run: `cdk diff YouTrackStack-Local`

Expected: Shows modification to EC2 instance MetadataOptions, may indicate instance replacement

**Step 4: Commit**

```bash
git add lib/youtrack-stack.ts
git commit -m "feat: enable IMDSv2 enforcement on YouTrack instance

- Add requireImdsv2: true to EC2 instance configuration
- Enforces session tokens for all metadata requests
- Prevents SSRF attacks against metadata service

Addresses Security Hub finding: IMDSv2 Required (MUST/MAJOR)
Deadline: Apr 30, 2026

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 3: Update Root Volume to Use Customer-Managed KMS

**Files:**
- Modify: `lib/youtrack-stack.ts:168-176` (blockDevices configuration)

**Step 1: Add encryptionKey to root volume**

In the `blockDevices` array, update the root volume configuration:

```typescript
blockDevices: [
  {
    deviceName: '/dev/xvda',
    volume: ec2.BlockDeviceVolume.ebs(30, {
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
      encryptionKey: ebsKmsKey,  // NEW: Use customer-managed key
    }),
  },
],
```

**Step 2: Validate CDK synth**

Run: `cdk synth YouTrackStack-Local`

Expected: CloudFormation template shows KMS key ID reference in root volume block device mapping

**Step 3: Check CDK diff**

Run: `cdk diff YouTrackStack-Local`

Expected: Shows modification to block device encryption key, likely triggers instance replacement

**Step 4: Commit**

```bash
git add lib/youtrack-stack.ts
git commit -m "feat: use customer-managed KMS for root volume encryption

- Add encryptionKey reference to root volume block device
- Replaces AWS-managed encryption with VW-controlled key
- Maintains 30GB gp3 volume specifications

Addresses Security Hub finding: Customer-Managed KMS Key (MUST/MEDIUM)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 4: Update Data Volume to Use Customer-Managed KMS

**Files:**
- Modify: `lib/youtrack-stack.ts:181-188` (data volume configuration)

**Step 1: Add encryptionKey to data volume**

In the `ec2.Volume` constructor (around line 181), add `encryptionKey`:

```typescript
const dataVolume = new ec2.Volume(this, 'YouTrackDataVolume', {
  // Use instance's AZ to ensure volume and instance are co-located
  availabilityZone: this.instance.instanceAvailabilityZone,
  size: cdk.Size.gibibytes(50),
  volumeType: ec2.EbsDeviceVolumeType.GP3,
  encrypted: true,
  encryptionKey: ebsKmsKey,  // NEW: Use customer-managed key
  removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
});
```

**Step 2: Add KMS key output**

After the existing outputs (around line 225), add KMS key output:

```typescript
new cdk.CfnOutput(this, 'VpcId', {
  value: sharedVpc.vpc.vpcId,
  description: 'Shared VPC ID',
});

new cdk.CfnOutput(this, 'KmsKeyId', {
  value: ebsKmsKey.keyId,
  description: 'KMS Key ID for EBS encryption',
});

new cdk.CfnOutput(this, 'KmsKeyArn', {
  value: ebsKmsKey.keyArn,
  description: 'KMS Key ARN for EBS encryption',
});
```

**Step 3: Validate CDK synth**

Run: `cdk synth YouTrackStack-Local`

Expected: CloudFormation template shows KMS key ID reference in data volume properties and new outputs

**Step 4: Check CDK diff**

Run: `cdk diff YouTrackStack-Local`

Expected: Shows modification to data volume encryption key (replacement) and new stack outputs

**Step 5: Commit**

```bash
git add lib/youtrack-stack.ts
git commit -m "feat: use customer-managed KMS for data volume encryption

- Add encryptionKey reference to YouTrack data volume
- Add KMS key ID and ARN outputs for migration scripts
- Replaces AWS-managed encryption with VW-controlled key
- Maintains 50GB gp3 volume with weekly DLM backup

Note: Existing volume (vol-0959de1b8294c8e9b) requires manual migration
via snapshot-restore process documented in design.

Addresses Security Hub finding: Customer-Managed KMS Key (MUST/MEDIUM)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 5: Create ECR Stack

**Files:**
- Create: `lib/ecr-stack.ts`

**Step 1: Create ECR stack file**

Create new file `lib/ecr-stack.ts`:

```typescript
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';

export class EcrStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Add compliance tags
    cdk.Tags.of(this).add('Environment', 'production');
    cdk.Tags.of(this).add('Project', 'YouTrack');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Owner', 'a2i5giv');
    cdk.Tags.of(this).add('Purpose', 'Container-Registry');

    // Import existing ECR repository
    const repository = ecr.Repository.fromRepositoryName(
      this,
      'YouTrackRepository',
      'youtrack'
    );

    // Lifecycle rule 1: Keep latest 5 tagged images
    repository.addLifecycleRule({
      description: 'Keep latest 5 tagged images',
      rulePriority: 1,
      tagStatus: ecr.TagStatus.TAGGED,
      maxImageCount: 5,
    });

    // Lifecycle rule 2: Delete tagged images older than 30 days
    repository.addLifecycleRule({
      description: 'Delete tagged images older than 30 days',
      rulePriority: 2,
      tagStatus: ecr.TagStatus.TAGGED,
      maxImageAge: cdk.Duration.days(30),
    });

    // Lifecycle rule 3: Delete untagged images after 7 days
    repository.addLifecycleRule({
      description: 'Delete untagged images after 7 days',
      rulePriority: 3,
      tagStatus: ecr.TagStatus.UNTAGGED,
      maxImageAge: cdk.Duration.days(7),
    });

    // Stack outputs
    new cdk.CfnOutput(this, 'RepositoryName', {
      value: repository.repositoryName,
      description: 'ECR Repository Name',
    });

    new cdk.CfnOutput(this, 'LifecyclePolicySummary', {
      value: 'Keep latest 5 tagged images OR images pushed within 30 days; Delete untagged after 7 days',
      description: 'Lifecycle policy summary',
    });
  }
}
```

**Step 2: Validate CDK synth**

Run: `cdk synth EcrStack-Local` (will fail - not instantiated yet)

Expected: Error - stack not defined in app

**Step 3: Add EcrStack to application**

Modify `bin/youtrack-app.ts` to import and instantiate EcrStack:

```typescript
#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { YouTrackStack } from '../lib/youtrack-stack';
import { AutomationStack } from '../lib/automation-stack';
import { EcrStack } from '../lib/ecr-stack';

const app = new cdk.App();

// YouTrack deployment for local deployment
const youtrackStack = new YouTrackStack(app, 'YouTrackStack-Local', {
  env: {
    account: '640664844884',
    region: 'eu-west-1'
  },
});

new AutomationStack(app, 'AutomationStack-Local', {
  env: {
    account: '640664844884',
    region: 'eu-west-1'
  },
  instanceId: youtrackStack.instance.instanceId,
});

new EcrStack(app, 'EcrStack-Local', {
  env: {
    account: '640664844884',
    region: 'eu-west-1'
  },
});
```

**Step 4: Validate CDK synth**

Run: `cdk synth EcrStack-Local`

Expected: CloudFormation template generates successfully with ECR lifecycle policy

**Step 5: Check CDK diff**

Run: `cdk diff EcrStack-Local`

Expected: Shows new stack with lifecycle policy resources (may show as no changes if stack doesn't exist)

**Step 6: Commit**

```bash
git add lib/ecr-stack.ts bin/youtrack-app.ts
git commit -m "feat: add ECR stack with lifecycle policies

- Create EcrStack to manage ECR repository policies
- Add lifecycle rule: keep latest 5 tagged images
- Add lifecycle rule: delete tagged images older than 30 days
- Add lifecycle rule: delete untagged images after 7 days
- Import existing youtrack repository
- Add compliance tags

Addresses Security Hub finding: ECR Lifecycle Policy (SHOULD)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 6: Document CVE Exception

**Files:**
- Create: `docs/security-exceptions.md`

**Step 1: Create security exceptions document**

Create new file `docs/security-exceptions.md`:

```markdown
# Security Exceptions

This document tracks security findings that are accepted as risk with ongoing monitoring.

## CVE-2016-1000027 - Spring Framework Deserialization

**Status:** Accepted Risk  
**Finding ID:** 1133ead4-6055-49e4-8c56-34f3a73ba686  
**Detected:** 2026-04-15  
**Resource:** `arn:aws:ecr:eu-west-1:640664844884:repository/youtrack/sha256:ed55f3fdcc215a794994b10afc33504dd14e901de8210c01f1bbcc992ed5d456`  
**Severity:** MUST/MINOR  
**Deadline:** 2026-06-10

### Vulnerability Description

Pivotal Spring Framework through 5.3.16 suffers from a potential remote code execution (RCE) issue if used for Java deserialization of untrusted data. The vulnerability requires:
1. Application uses Spring Framework for Java deserialization
2. Application deserializes untrusted data from external sources
3. No authentication or input validation

**CVE Details:** https://nvd.nist.gov/vuln/detail/CVE-2016-1000027

**Vendor Position:** "Untrusted data is not an intended use case. The product's behavior will not be changed because some users rely on deserialization of trusted data."

### Risk Assessment

**Likelihood:** LOW
- YouTrack runs in PRIVATE_ISOLATED VPC subnet
- No public IP address assigned to instance
- Access only via SSM Session Manager (requires AWS authentication)
- Port 8080 restricted to RFC 1918 private IP ranges
- No external data sources deserializing to YouTrack
- YouTrack is internal development tool, not exposed to untrusted users

**Impact:** HIGH (if exploited)
- Remote code execution within YouTrack container
- Potential data access to issues/projects
- Container runs as UID 13001 (non-root)

**Overall Risk:** LOW (High impact × Low likelihood)

### Mitigation Actions

**Current Mitigations:**
1. Network isolation (PRIVATE_ISOLATED subnet, no public IP)
2. Access control (SSM Session Manager with IAM authentication)
3. Firewall rules (Security Group restricts port 8080 to private IPs)
4. Container user isolation (non-root UID 13001)

**Ongoing Monitoring:**
1. Subscribe to JetBrains YouTrack security advisories
2. Review JetBrains release notes for security patches
3. Monitor One.Cloud Security Hub for updated findings
4. Quarterly review (see schedule below)

**Planned Actions:**
1. Upgrade to latest YouTrack version when available
2. Test new versions in dev environment before production
3. Re-assess risk if network configuration changes

### Review Schedule

**Quarterly Review Dates:**
- Q2 2026: June 30, 2026
- Q3 2026: September 30, 2026
- Q4 2026: December 31, 2026
- Q1 2027: March 31, 2027

**Review Checklist:**
- [ ] Check for new YouTrack releases with security patches
- [ ] Verify network isolation still in place
- [ ] Confirm no new attack vectors introduced
- [ ] Review Security Hub for finding status changes
- [ ] Update risk assessment if conditions changed

### Approval

**Risk Accepted By:** José Chumbo (a2i5giv)  
**Date:** 2026-04-27  
**Justification:** Vendor-dependent fix, low risk due to network isolation, mitigation controls in place

**Next Review:** 2026-06-30
```

**Step 2: Verify file created**

Run: `cat docs/security-exceptions.md | head -20`

Expected: First 20 lines of security exceptions document displayed

**Step 3: Commit**

```bash
git add docs/security-exceptions.md
git commit -m "docs: add security exception for CVE-2016-1000027

- Document Spring Framework deserialization vulnerability
- Assess risk as LOW due to network isolation
- Define current mitigations and monitoring plan
- Establish quarterly review schedule
- Accept risk pending JetBrains security patch

Addresses Security Hub finding: CVE-2016-1000027 (MUST/MINOR)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 7: Update CLAUDE.md Documentation

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update Current Deployment section**

Locate the "Current Deployment" section and update instance ID:

```markdown
## Current Deployment

**Migration Status:** Infrastructure migrated from CodeCommit to GitHub on 2026-04-27

**Deployment Method:** Manual CDK deployment from local workstation
- Application Stacks: `YouTrackStack-Local`, `AutomationStack-Local`, `EcrStack-Local`
- Repository: GitHub `https://github.com/vwChumbo/YouTrack.git`

**Compliance Note:** GitHub is used as the source code provider to comply with One.Cloud regulations. CodeCommit is not permitted for source code storage.

**Instance Details** (as of last deployment):
- Stack: YouTrackStack-Local
- Instance ID: i-0591fecf34c1b50ca
- Private IP: 192.168.146.15
- Access URL: http://192.168.146.15:8080 (via SSM port forwarding)
- VPC ID: vpc-05b5078f709cfc904
- Availability Zone: eu-west-1a
- Region: eu-west-1
- Account: 640664844884

**Encryption:**
- KMS Key: Customer-managed key (alias/youtrack-ebs-encryption)
- Root Volume: 30GB gp3, encrypted with VW-controlled KMS key
- Data Volume: 50GB gp3, encrypted with VW-controlled KMS key

**Instance Metadata:**
- IMDSv2: Enforced (HttpTokens required)
```

**Step 2: Update Development Commands section**

Add ECR stack to deployment commands:

```markdown
## Development Commands

### CDK Deployment

**Deploy all stacks:**
```bash
cdk deploy YouTrackStack-Local AutomationStack-Local EcrStack-Local
```

**Deploy individual stack:**
```bash
cdk deploy YouTrackStack-Local
cdk deploy AutomationStack-Local
cdk deploy EcrStack-Local
```

**If SSL/CA certificate errors occur:**
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk deploy YouTrackStack-Local AutomationStack-Local EcrStack-Local
```
```

**Step 3: Add Security Compliance section**

After "Automation" section, add new "Security Compliance" section:

```markdown
## Security Compliance

### IMDSv2 Enforcement

The EC2 instance requires Instance Metadata Service Version 2 (IMDSv2) to prevent SSRF attacks:
- HttpTokens set to "required"
- All metadata requests must include session token
- Enforced via `requireImdsv2: true` in CDK

### Customer-Managed KMS Encryption

All EBS volumes use Volkswagen-controlled KMS encryption keys:
- KMS Key Alias: `alias/youtrack-ebs-encryption`
- Key Rotation: Enabled (annual)
- Service Access: EC2, DLM
- Root Volume: Encrypted with customer-managed key
- Data Volume: Encrypted with customer-managed key
- Snapshots: Encrypted with same key via DLM

**Key Policy:**
- EC2 service principal: Decrypt, DescribeKey, CreateGrant
- DLM service principal: Encrypt, Decrypt, DescribeKey, CreateGrant
- Account root: Full administrative access

### ECR Security Policies

**Lifecycle Policy:**
- Keep latest 5 tagged images (always preserved)
- Delete tagged images older than 30 days (unless in latest 5)
- Delete untagged images after 7 days

**Tag Immutability:**
- Enabled (IMMUTABLE)
- Prevents tag overwrites
- Forces explicit versioning

**Enable tag immutability (one-time):**
```bash
aws ecr put-image-tag-mutability \
  --repository-name youtrack \
  --image-tag-mutability IMMUTABLE \
  --region eu-west-1
```

### Security Exceptions

Security findings that are accepted as risk are documented in `docs/security-exceptions.md`:
- CVE-2016-1000027 (Spring Framework): Accepted pending vendor fix
- Quarterly review schedule maintained
```

**Step 4: Verify changes**

Run: `git diff CLAUDE.md`

Expected: Shows additions to Current Deployment, Development Commands, and new Security Compliance section

**Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with security compliance details

- Update instance ID to i-0591fecf34c1b50ca
- Add EcrStack-Local to deployment commands
- Document IMDSv2 enforcement
- Document customer-managed KMS encryption
- Document ECR security policies
- Add Security Compliance section
- Reference security exceptions document

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 8: Deploy CDK Changes (Dry Run)

**Files:**
- None (validation only)

**Step 1: Synthesize all stacks**

Run: `cdk synth`

Expected: All three stacks synthesize successfully without errors

**Step 2: Check YouTrackStack diff**

Run: `cdk diff YouTrackStack-Local`

Expected output shows:
- KMS key addition (new resource)
- EC2 instance modification (IMDSv2, may trigger replacement)
- Root volume encryption key change (may trigger replacement)
- Data volume encryption key change (will trigger replacement)
- New KMS outputs

**Step 3: Check EcrStack diff**

Run: `cdk diff EcrStack-Local`

Expected: New stack creation (or no changes if stack already exists)

**Step 4: Document deployment readiness**

Create file: `docs/deployment-checklist.md`

```markdown
# Deployment Checklist - Security Findings Remediation

**Deployment Date:** TBD  
**Maintenance Window:** TBD (20-30 min downtime expected)

## Pre-Deployment

- [ ] Code reviewed and approved
- [ ] All commits pushed to GitHub main branch
- [ ] CloudFormation changesets reviewed
- [ ] Backup snapshot identified: `<snapshot-id>`
- [ ] Maintenance window scheduled and stakeholders notified

## Deployment Steps

### Phase 1: Deploy CDK Changes (10 min)

```bash
# Deploy YouTrackStack with KMS and IMDSv2
cdk deploy YouTrackStack-Local --require-approval never

# Deploy EcrStack with lifecycle policies
cdk deploy EcrStack-Local --require-approval never
```

**Note:** YouTrackStack deployment may replace EC2 instance. Monitor CloudFormation console.

**Validation:**
- [ ] Both stacks deployed successfully
- [ ] Instance running with new instance ID
- [ ] KMS key created with correct alias
- [ ] ECR lifecycle policy visible in console

### Phase 2: Enable ECR Tag Immutability (2 min)

```bash
aws ecr put-image-tag-mutability \
  --repository-name youtrack \
  --image-tag-mutability IMMUTABLE \
  --region eu-west-1
```

**Validation:**
- [ ] Tag immutability enabled (check ECR console)

### Phase 3: Verify IMDSv2 Enforcement (5 min)

```bash
# Check instance metadata configuration
aws ec2 describe-instances --instance-ids <new-instance-id> --region eu-west-1 \
  --query 'Reservations[0].Instances[0].MetadataOptions.HttpTokens'

# Expected: "required"

# Test SSM connectivity
aws ssm start-session --target <new-instance-id> --region eu-west-1

# Inside instance: verify Docker and YouTrack running
docker ps | grep youtrack
```

**Validation:**
- [ ] IMDSv2 enforced (HttpTokens = "required")
- [ ] SSM Session Manager works
- [ ] YouTrack container running

### Phase 4: Migrate Data Volume (30 min)

**Note:** This phase requires scheduled downtime.

```bash
# 1. Get KMS key ARN from stack outputs
aws cloudformation describe-stacks --stack-name YouTrackStack-Local --region eu-west-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`KmsKeyArn`].OutputValue' --output text

# 2. List available snapshots
aws ec2 describe-snapshots --owner-ids 640664844884 --region eu-west-1 \
  --filters "Name=tag:Backup,Values=weekly-dlm" \
  --query 'Snapshots | sort_by(@, &StartTime) | [-1].[SnapshotId, StartTime, VolumeSize]'

# 3. Create new volume from snapshot with KMS key
aws ec2 create-volume \
  --snapshot-id <snapshot-id> \
  --availability-zone eu-west-1a \
  --volume-type gp3 \
  --encrypted \
  --kms-key-id <kms-key-arn> \
  --region eu-west-1 \
  --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=youtrack-data-new},{Key=Backup,Value=weekly-dlm}]'

# Wait for volume creation
aws ec2 wait volume-available --volume-ids <new-volume-id> --region eu-west-1

# 4. Stop instance
aws ec2 stop-instances --instance-ids <instance-id> --region eu-west-1
aws ec2 wait instance-stopped --instance-ids <instance-id> --region eu-west-1

# 5. Detach old volume
aws ec2 detach-volume --volume-id vol-0959de1b8294c8e9b --region eu-west-1
aws ec2 wait volume-available --volume-ids vol-0959de1b8294c8e9b --region eu-west-1

# 6. Attach new volume
aws ec2 attach-volume \
  --volume-id <new-volume-id> \
  --instance-id <instance-id> \
  --device /dev/sdf \
  --region eu-west-1
aws ec2 wait volume-in-use --volume-ids <new-volume-id> --region eu-west-1

# 7. Start instance
aws ec2 start-instances --instance-ids <instance-id> --region eu-west-1
aws ec2 wait instance-running --instance-ids <instance-id> --region eu-west-1
```

**Validation:**
- [ ] New volume created with KMS encryption
- [ ] Old volume detached successfully
- [ ] New volume attached as /dev/sdf
- [ ] Instance started successfully

### Phase 5: Verify Data Integrity (10 min)

```bash
# Connect via SSM
aws ssm start-session --target <instance-id> --region eu-west-1

# Inside instance:
df -h | grep youtrack-data                    # Check mount
ls -la /var/youtrack-data                     # Check files and ownership
docker ps | grep youtrack                     # Check container running
docker logs youtrack --tail 50                # Check for errors

# Port forward to access UI
aws ssm start-session --target <instance-id> --region eu-west-1 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8080"],"localPortNumber":["8484"]}'

# Access http://localhost:8484 in browser
```

**Validation:**
- [ ] /var/youtrack-data mounted correctly
- [ ] Files owned by 13001:13001
- [ ] YouTrack container running
- [ ] No errors in container logs
- [ ] YouTrack UI accessible
- [ ] Existing issues/projects visible
- [ ] Can create/edit/delete test issue

## Post-Deployment

### Verify Security Hub Findings (48 hours)

- [ ] IMDSv2 finding status = RESOLVED
- [ ] Customer-Managed KMS finding status = RESOLVED
- [ ] ECR Lifecycle Policy finding status = RESOLVED
- [ ] ECR Tag Immutability finding status = RESOLVED

### Monitor Stability (1 week)

- [ ] No container restarts: `docker ps -a | grep youtrack`
- [ ] No volume errors: `dmesg | grep error`
- [ ] DLM snapshot succeeded (Friday 18:00 UTC)
- [ ] ECR lifecycle policy executed (check image count)

### Cleanup (After 1 week validation)

```bash
# Delete old data volume
aws ec2 delete-volume --volume-id vol-0959de1b8294c8e9b --region eu-west-1
```

## Rollback Procedures

### Rollback CDK Changes

```bash
# Revert commits
git revert <commit-hash> --no-edit

# Redeploy old version
cdk deploy YouTrackStack-Local --require-approval never
```

### Rollback Data Volume

```bash
# Stop instance
aws ec2 stop-instances --instance-ids <instance-id> --region eu-west-1
aws ec2 wait instance-stopped --instance-ids <instance-id> --region eu-west-1

# Detach new volume
aws ec2 detach-volume --volume-id <new-volume-id> --region eu-west-1
aws ec2 wait volume-available --volume-ids <new-volume-id> --region eu-west-1

# Reattach old volume
aws ec2 attach-volume \
  --volume-id vol-0959de1b8294c8e9b \
  --instance-id <instance-id> \
  --device /dev/sdf \
  --region eu-west-1

# Start instance
aws ec2 start-instances --instance-ids <instance-id> --region eu-west-1
```

## Contacts

**On-Call Engineer:** José Chumbo (a2i5giv)  
**Escalation:** One.Cloud Support
```

**Step 5: Commit deployment checklist**

```bash
git add docs/deployment-checklist.md
git commit -m "docs: add deployment checklist for security remediation

- Pre-deployment validation steps
- Phase-by-phase deployment procedures
- Data volume migration commands with KMS
- Post-deployment verification checklist
- Rollback procedures for CDK and volume changes
- Contact information

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 9: Final Validation and Tag

**Files:**
- None (validation only)

**Step 1: Validate all commits**

Run: `git log --oneline -10`

Expected: Shows all 8 commits from this implementation

**Step 2: Validate working tree clean**

Run: `git status`

Expected: "nothing to commit, working tree clean"

**Step 3: Validate CDK synth works**

Run: `cdk synth --all`

Expected: All stacks synthesize without errors

**Step 4: Create git tag**

```bash
git tag -a v1.1.0-security-findings -m "Security findings remediation - IMDSv2, KMS, ECR policies

Remediates 4 of 5 One.Cloud Security Hub findings:
- IMDSv2 enforcement (MUST/MAJOR)
- Customer-managed KMS encryption (MUST/MEDIUM)
- ECR lifecycle policy (SHOULD)
- ECR tag immutability (SHOULD)

Documents CVE-2016-1000027 as accepted risk.

Deployment requires:
1. CDK deploy YouTrackStack-Local + EcrStack-Local
2. Manual data volume migration (30 min downtime)
3. Enable ECR tag immutability via CLI

See docs/deployment-checklist.md for full procedure."
```

**Step 5: Verify tag created**

Run: `git tag -l -n10 v1.1.0-security-findings`

Expected: Tag message displayed

**Step 6: Push commits and tags**

```bash
git push origin main
git push origin v1.1.0-security-findings
```

---

## Post-Implementation Steps

**Not included in this implementation plan:**

1. **Deploy to AWS** - Follow `docs/deployment-checklist.md` during scheduled maintenance window
2. **Manual data volume migration** - Execute Phase 4 of deployment checklist with 30 min downtime
3. **Monitor Security Hub** - Verify findings resolve within 48 hours
4. **Schedule quarterly CVE review** - Add calendar reminders per `docs/security-exceptions.md`

---

## Summary

**Total Tasks:** 9  
**Estimated Time:** 60-90 minutes (implementation only)  
**Commits:** 9 commits + 1 git tag  
**Files Modified:** 3 files  
**Files Created:** 4 files  

**Security Findings Remediated:**
- ✅ IMDSv2 enforcement (CDK property)
- ✅ Customer-managed KMS (CDK + manual migration)
- ✅ ECR lifecycle policy (CDK)
- ✅ ECR tag immutability (CLI command)
- ✅ CVE-2016-1000027 (documented exception)

**Deployment Impact:**
- EC2 instance may be replaced (new instance ID)
- Data volume requires manual migration (30 min downtime)
- Root volume replaced automatically by CDK
- ECR policies non-disruptive

**Next Steps:**
1. Code review and approval
2. Schedule maintenance window
3. Execute `docs/deployment-checklist.md`
4. Monitor Security Hub for finding resolution
