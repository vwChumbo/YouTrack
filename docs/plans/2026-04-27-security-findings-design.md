# Security Findings Remediation Design

**Date:** 2026-04-27  
**Author:** José Chumbo (with Claude Code)  
**Status:** Approved

## Executive Summary

This design addresses 5 security findings from One.Cloud Security Hub for the YouTrack deployment. We will remediate 4 findings through CDK infrastructure changes and document 1 as an accepted risk pending vendor updates.

**Findings Addressed:**
1. ⚠️ **IMDSv2 Required** (MUST/MAJOR) - Deadline: Apr 30, 2026
2. ⚠️ **Customer-Managed KMS Key** (MUST/MEDIUM) - Deadline: May 14, 2026
3. ⚠️ **ECR Lifecycle Policy** (SHOULD)
4. ⚠️ **ECR Tag Immutability** (SHOULD)
5. ⚠️ **CVE-2016-1000027 in YouTrack Image** (MUST/MINOR) - Accepted Risk

## Architecture Overview

All remediation is implemented via AWS CDK infrastructure-as-code changes to maintain GitOps compliance. The deployment maintains the existing local CDK deployment workflow with manual execution.

```
CDK Deploy → YouTrackStack-Local
              ├─ EC2 Instance (IMDSv2 enabled)
              │   ├─ Root Volume (customer-managed KMS)
              │   └─ Data Volume (customer-managed KMS)
              ├─ KMS Key (new resource)
              └─ ECR Repository (lifecycle + immutability)
```

**Impact Assessment:**
- IMDSv2: Zero downtime, instance update in-place
- KMS Key: One-time data migration with ~30min planned downtime
- ECR Changes: Zero impact, policy enforcement only

## Components

### 1. KMS Key (New Resource)

**Purpose:** Customer-managed encryption key under Volkswagen control for EBS volume encryption.

**Specifications:**
- Key type: Symmetric encryption (AES-256)
- Key rotation: Enabled (annual automatic rotation)
- Alias: `alias/youtrack-ebs-encryption`
- Removal policy: `RETAIN` (never delete key material)

**Key Policy:**
- EC2 service principal: `CreateGrant`, `Decrypt`, `DescribeKey` (for volume attachment)
- DLM service principal: `CreateGrant`, `Decrypt`, `Encrypt` (for snapshot creation)
- Account root: Full administrative access
- VPC Flow Logs: Denied (not needed for this use case)

**CDK Implementation:**
```typescript
const kmsKey = new kms.Key(this, 'YouTrackEbsKey', {
  description: 'Customer-managed key for YouTrack EBS encryption',
  enableKeyRotation: true,
  removalPolicy: cdk.RemovalPolicy.RETAIN,
});

kmsKey.addAlias('alias/youtrack-ebs-encryption');

// Grant EC2 service access
kmsKey.grantEncryptDecrypt(new iam.ServicePrincipal('ec2.amazonaws.com'));

// Grant DLM service access for snapshots
kmsKey.addToResourcePolicy(new iam.PolicyStatement({
  sid: 'Allow DLM to use the key',
  principals: [new iam.ServicePrincipal('dlm.amazonaws.com')],
  actions: [
    'kms:CreateGrant',
    'kms:Decrypt',
    'kms:Encrypt',
    'kms:DescribeKey',
  ],
  resources: ['*'],
}));
```

### 2. EC2 Instance (Modifications)

**IMDSv2 Configuration:**
- Add property: `requireImdsv2: true`
- Enforcement: HttpTokens set to "required"
- Impact: None (YouTrack doesn't use instance metadata)

**Root Volume Encryption:**
- Update `blockDevices[0]` to specify `encryptionKey: kmsKey`
- Size: 30GB gp3 (unchanged)
- Device: `/dev/xvda` (unchanged)

**CDK Changes:**
```typescript
this.instance = new ec2.Instance(this, 'YouTrackInstance', {
  // ... existing config ...
  requireImdsv2: true,  // NEW: Enable IMDSv2
  blockDevices: [
    {
      deviceName: '/dev/xvda',
      volume: ec2.BlockDeviceVolume.ebs(30, {
        volumeType: ec2.EbsDeviceVolumeType.GP3,
        encrypted: true,
        encryptionKey: kmsKey,  // NEW: Use customer-managed key
      }),
    },
  ],
});
```

### 3. EBS Data Volume (Modifications)

**Encryption Update:**
- Change from AWS-managed key to customer-managed KMS key
- Size: 50GB gp3 (unchanged)
- Mount point: `/var/youtrack-data` (unchanged)
- Backup tag: `Backup: weekly-dlm` (unchanged)

**CDK Changes:**
```typescript
const dataVolume = new ec2.Volume(this, 'YouTrackDataVolume', {
  availabilityZone: this.instance.instanceAvailabilityZone,
  size: cdk.Size.gibibytes(50),
  volumeType: ec2.EbsDeviceVolumeType.GP3,
  encrypted: true,
  encryptionKey: kmsKey,  // NEW: Use customer-managed key
  removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
});
```

**Migration Process (One-Time Manual Operation):**

1. **Pre-Migration:**
   ```bash
   # List available snapshots
   aws ec2 describe-snapshots --owner-ids 640664844884 --region eu-west-1 \
     --filters "Name=tag:Backup,Values=weekly-dlm" \
     --query 'Snapshots | sort_by(@, &StartTime) | [-1].[SnapshotId, StartTime, VolumeSize]'
   ```

2. **Create New Volume:**
   ```bash
   # Replace snap-xxxxx with latest snapshot ID
   # Replace key-id with KMS key ARN from CDK outputs
   aws ec2 create-volume \
     --snapshot-id snap-xxxxx \
     --availability-zone eu-west-1a \
     --volume-type gp3 \
     --encrypted \
     --kms-key-id <kms-key-arn> \
     --region eu-west-1 \
     --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=youtrack-data-new},{Key=Backup,Value=weekly-dlm}]'
   ```

3. **Volume Swap (Maintenance Window):**
   ```bash
   # Stop instance
   aws ec2 stop-instances --instance-ids i-0591fecf34c1b50ca --region eu-west-1
   aws ec2 wait instance-stopped --instance-ids i-0591fecf34c1b50ca --region eu-west-1
   
   # Detach old volume
   aws ec2 detach-volume --volume-id vol-0959de1b8294c8e9b --region eu-west-1
   aws ec2 wait volume-available --volume-ids vol-0959de1b8294c8e9b --region eu-west-1
   
   # Attach new volume
   aws ec2 attach-volume \
     --volume-id <new-volume-id> \
     --instance-id i-0591fecf34c1b50ca \
     --device /dev/sdf \
     --region eu-west-1
   aws ec2 wait volume-in-use --volume-ids <new-volume-id> --region eu-west-1
   
   # Start instance
   aws ec2 start-instances --instance-ids i-0591fecf34c1b50ca --region eu-west-1
   aws ec2 wait instance-running --instance-ids i-0591fecf34c1b50ca --region eu-west-1
   ```

4. **Verification:**
   ```bash
   # Connect via SSM
   aws ssm start-session --target i-0591fecf34c1b50ca --region eu-west-1
   
   # Verify mount
   df -h | grep youtrack-data
   ls -la /var/youtrack-data
   
   # Check Docker container
   docker ps | grep youtrack
   docker logs youtrack --tail 50
   ```

5. **Cleanup (After 1 Week Validation):**
   ```bash
   # Delete old volume
   aws ec2 delete-volume --volume-id vol-0959de1b8294c8e9b --region eu-west-1
   ```

**Estimated Downtime:** 20-30 minutes (stop → swap → start → container ready)

**Rollback Plan:** If issues occur, detach new volume and reattach old volume (vol-0959de1b8294c8e9b) to return to previous state.

### 4. ECR Repository (Modifications)

**Lifecycle Policy:**
- Keep latest 5 tagged images (by push date) - always preserved
- Delete tagged images older than 30 days (unless in latest 5)
- Delete untagged images after 7 days

**Tag Immutability:**
- Set to `IMMUTABLE`
- Prevents accidental tag overwrites
- Forces explicit versioning

**CDK Implementation:**

Create new file: `lib/ecr-stack.ts`

```typescript
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';

export class EcrStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const repository = ecr.Repository.fromRepositoryName(
      this, 
      'YouTrackRepository',
      'youtrack'
    );

    // Apply lifecycle policy
    repository.addLifecycleRule({
      description: 'Keep latest 5 tagged images',
      rulePriority: 1,
      tagStatus: ecr.TagStatus.TAGGED,
      maxImageCount: 5,
    });

    repository.addLifecycleRule({
      description: 'Delete tagged images older than 30 days',
      rulePriority: 2,
      tagStatus: ecr.TagStatus.TAGGED,
      maxImageAge: cdk.Duration.days(30),
    });

    repository.addLifecycleRule({
      description: 'Delete untagged images after 7 days',
      rulePriority: 3,
      tagStatus: ecr.TagStatus.UNTAGGED,
      maxImageAge: cdk.Duration.days(7),
    });
  }
}
```

**Note:** Tag immutability must be enabled via AWS console or CLI (cannot be changed via CDK on existing repository):

```bash
aws ecr put-image-tag-mutability \
  --repository-name youtrack \
  --image-tag-mutability IMMUTABLE \
  --region eu-west-1
```

### 5. CVE-2016-1000027 (Accepted Risk)

**Finding:** Spring Framework vulnerability in YouTrack container image

**Decision:** Accept as risk with monitoring

**Rationale:**
- Vulnerability requires Java deserialization of untrusted data
- YouTrack runs in private VPC with no public internet access
- Only accessible via SSM port forwarding from authorized users
- JetBrains (vendor) responsible for patching YouTrack image
- Risk severity: LOW in current network configuration

**Mitigation Actions:**
1. Monitor JetBrains release notes for YouTrack security updates
2. Subscribe to YouTrack security advisories
3. Document in security exception log
4. Review quarterly for vendor patches

**Documentation:**
Create `docs/security-exceptions.md` with CVE details, risk assessment, and review schedule.

## Data Flow

### Normal Operation (Post-Migration)

```
Developer Workstation
    │
    ├─ cdk deploy YouTrackStack-Local
    │   └─> EC2 Instance (IMDSv2, KMS volumes)
    │
    ├─ cdk deploy EcrStack-Local  
    │   └─> ECR Repository (lifecycle, immutability)
    │
    └─ docker push to ECR
        └─> Lifecycle policy enforces retention rules
```

### Instance Boot Flow (With KMS)

```
EC2 Instance Start
    │
    ├─ EC2 requests KMS key access
    ├─ KMS validates EC2 service principal
    ├─ KMS decrypts volume encryption key
    │
    ├─ Root volume mounted (/)
    ├─ Data volume mounted (/var/youtrack-data)
    │
    ├─ UserData script executes
    │   ├─ Docker installed
    │   ├─ ECR authentication (via IAM role)
    │   └─ YouTrack container starts
    │
    └─ Instance ready
```

### DLM Snapshot Flow (With KMS)

```
Friday 18:00 UTC
    │
    ├─ DLM identifies volumes with tag Backup: weekly-dlm
    ├─ DLM requests KMS key access
    ├─ KMS validates DLM service principal
    ├─ KMS encrypts snapshot with same key
    │
    ├─ Snapshot created (encrypted with customer-managed key)
    ├─ Tags copied to snapshot
    │
    └─ Old snapshots (>4 weeks) deleted
```

## Error Handling and Rollback

### CDK Deployment Failures

**IMDSv2 Change:**
- Risk: LOW - Non-destructive property change
- Rollback: Remove `requireImdsv2: true`, redeploy
- Validation: Check SSM connectivity and ECR authentication post-deploy

**KMS Key Creation:**
- Risk: LOW - New resource, doesn't affect existing volumes
- Rollback: Key retained even if stack deleted (`removalPolicy: RETAIN`)
- Validation: Check key policy grants in AWS console

**ECR Policy Changes:**
- Risk: LOW - Only affects cleanup behavior, not existing images
- Rollback: Remove lifecycle rules, redeploy
- Validation: Check policy JSON in ECR console after 24h

### Migration Failures

**Snapshot Not Found:**
- Fallback: Use older snapshot from DLM history
- Verification: Check snapshot age vs last known good state

**Volume Creation Fails:**
- Cause: KMS key policy missing EC2 permissions
- Fix: Update key policy to grant `ec2.amazonaws.com` decrypt access
- Retry: Re-run create-volume command

**Volume Attachment Fails:**
- Cause: Volume and instance in different AZs
- Fix: Verify both in eu-west-1a
- Retry: Re-run attach-volume command

**Instance Won't Start:**
- Diagnosis: Check AWS console for error messages
- Rollback: Detach new volume, reattach old volume (vol-0959de1b8294c8e9b)
- Recovery: Instance returns to previous working state

**Mount Failure:**
- Symptom: `/var/youtrack-data` not mounted
- Diagnosis: `sudo mount -a` to see fstab errors
- Fix: UserData should handle mount automatically on boot
- Workaround: Manual mount `sudo mount /dev/sdf /var/youtrack-data`

**Data Corruption:**
- Detection: YouTrack UI shows errors or missing data
- Rollback: Stop instance, detach new volume, reattach old volume
- Last Resort: Restore from older DLM snapshot

### Validation Checks

**Post-Deployment (IMDSv2):**
```bash
# Check IMDSv2 enforcement
aws ec2 describe-instances --instance-ids i-0591fecf34c1b50ca \
  --query 'Reservations[0].Instances[0].MetadataOptions'

# Expected: HttpTokens = "required"
```

**Post-Migration (KMS Volume):**
```bash
# Verify volume encryption
aws ec2 describe-volumes --volume-ids <new-volume-id> \
  --query 'Volumes[0].{Encrypted:Encrypted,KmsKeyId:KmsKeyId}'

# Connect via SSM and check mount
aws ssm start-session --target i-0591fecf34c1b50ca --region eu-west-1

# Inside instance:
df -h | grep youtrack-data    # Should show /dev/sdf mounted
ls -la /var/youtrack-data     # Should show YouTrack files owned by 13001:13001
docker ps | grep youtrack     # Container should be running
docker logs youtrack --tail 50  # No errors in logs
```

**Post-Deployment (ECR):**
```bash
# Check lifecycle policy
aws ecr get-lifecycle-policy --repository-name youtrack --region eu-west-1

# Check tag immutability
aws ecr describe-repositories --repository-names youtrack --region eu-west-1 \
  --query 'repositories[0].imageTagMutability'

# Expected: "IMMUTABLE"
```

## Testing Strategy

### Pre-Deployment Testing

1. **CDK Synth Validation:**
   ```bash
   cdk synth YouTrackStack-Local
   cdk synth EcrStack-Local
   ```
   - Verify KMS key appears in template
   - Check IMDSv2 property in EC2 instance metadata options
   - Confirm encryptionKey references in both volumes

2. **Review CloudFormation Changeset:**
   ```bash
   cdk diff YouTrackStack-Local
   ```
   - Identify resources being replaced (instance may need replacement)
   - Verify no unexpected resource deletions
   - Check for volume replacement (should be update-in-place)

### Post-Deployment Testing (CDK Changes)

**Phase 1: IMDSv2 Verification**
1. Instance still accessible via SSM Session Manager
2. Docker authenticates to ECR successfully
3. YouTrack container pulls image and starts
4. No errors in `/var/log/youtrack-setup.log`

**Phase 2: ECR Policy Verification**
1. Lifecycle policy visible in ECR console
2. Test tag immutability:
   ```bash
   # Push test image
   docker tag youtrack:test 640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:test
   docker push 640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:test
   
   # Attempt to overwrite same tag (should fail)
   docker tag youtrack:test2 640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:test
   docker push 640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:test
   # Expected: Error - tag is immutable
   ```
3. Wait 24-48h for lifecycle policy to execute first cleanup

### Post-Migration Testing (KMS Volume)

**Immediate Validation (0-5 minutes):**
1. Instance starts successfully
2. SSM Session Manager connection works
3. Volume mounted at `/var/youtrack-data`
4. Ownership correct: `chown 13001:13001 /var/youtrack-data`
5. YouTrack Docker container running

**Functional Validation (5-15 minutes):**
1. Port forward to YouTrack UI:
   ```bash
   aws ssm start-session --target i-0591fecf34c1b50ca --region eu-west-1 \
     --document-name AWS-StartPortForwardingSession \
     --parameters '{"portNumber":["8080"],"localPortNumber":["8484"]}'
   ```
2. Access `http://localhost:8484` in browser
3. Login to YouTrack
4. Verify existing issues/projects visible
5. Create test issue
6. Edit test issue
7. Delete test issue

**Persistence Validation (24 hours):**
1. Check no container restarts: `docker ps -a | grep youtrack`
2. Review container logs: `docker logs youtrack | grep -i error`
3. Verify no volume errors in system logs: `dmesg | grep -i error`
4. Check DLM can snapshot new volume (Friday 18:00 UTC)

**Long-term Validation (1 week):**
1. Monitor YouTrack stability (no crashes)
2. Verify DLM snapshot succeeded
3. Test restore from new KMS-encrypted snapshot
4. Delete old volume if all validation passed

### Acceptance Criteria

**Security Compliance:**
- [ ] Security Hub finding "IMDSv2 Required" status = RESOLVED
- [ ] Security Hub finding "Customer-Managed KMS" status = RESOLVED
- [ ] Security Hub finding "ECR Lifecycle Policy" status = RESOLVED
- [ ] Security Hub finding "ECR Tag Immutability" status = RESOLVED
- [ ] CVE-2016-1000027 documented in security exceptions log

**Functional Requirements:**
- [ ] Zero data loss during migration
- [ ] YouTrack UI accessible and responsive
- [ ] All existing issues/projects intact
- [ ] Can create, edit, delete issues
- [ ] SSM Session Manager access works
- [ ] Docker container stable (no restarts)

**Operational Requirements:**
- [ ] DLM snapshots succeed with new KMS key
- [ ] ECR lifecycle policy executes within 48h
- [ ] Tag immutability prevents overwrites
- [ ] CDK deployment process unchanged
- [ ] Documentation updated (CLAUDE.md)

**Timeline:**
- All findings resolved within 48 hours of completion
- Migration scheduled during maintenance window (evening/weekend)
- Total estimated time: 2-3 hours including validation

## Implementation Sequence

1. **Deploy KMS Key and IMDSv2 (Low Risk):**
   - Update `lib/youtrack-stack.ts` with KMS key and IMDSv2
   - Deploy via `cdk deploy YouTrackStack-Local`
   - Validate IMDSv2 enforcement
   - Note: This may trigger instance replacement - schedule during maintenance window

2. **Deploy ECR Policies (Zero Risk):**
   - Create `lib/ecr-stack.ts`
   - Update `bin/youtrack-app.ts` to instantiate EcrStack
   - Deploy via `cdk deploy EcrStack-Local`
   - Enable tag immutability via AWS CLI

3. **Migrate Data Volume (Scheduled Downtime):**
   - Execute manual migration steps (see Component 3)
   - Validate data integrity
   - Monitor for 1 week before cleanup

4. **Document CVE Exception:**
   - Create `docs/security-exceptions.md`
   - Include CVE details, risk assessment, mitigation
   - Commit to repository

5. **Update Documentation:**
   - Update CLAUDE.md with new KMS key details
   - Update instance ID if replaced
   - Document new security posture

## Security Considerations

**KMS Key Management:**
- Key policy principle of least privilege
- Only EC2 and DLM service principals granted access
- Account root retains administrative access for recovery
- Key rotation enabled for compliance
- Key never deleted (RETAIN policy)

**IMDSv2 Benefits:**
- Prevents SSRF attacks against metadata service
- Requires session token for all metadata requests
- Defense-in-depth against container escape scenarios

**ECR Security:**
- Tag immutability prevents supply chain attacks (tag poisoning)
- Lifecycle policy reduces attack surface (fewer old images)
- Forces explicit versioning discipline

**Network Isolation:**
- YouTrack remains in PRIVATE_ISOLATED subnet
- No public IP address
- Access only via SSM Session Manager
- Port 8080 restricted to RFC 1918 private ranges

## Cost Impact

**KMS Key:**
- $1/month per key
- $0.03 per 10,000 encryption/decryption requests
- Estimated: $1.50/month (key + snapshot operations)

**ECR Lifecycle Policy:**
- Cost reduction: Removes old images (saves ~$0.50-1/month in storage)

**Tag Immutability:**
- No cost impact

**Net Change:** +$0.50-1/month (minimal increase)

## Dependencies

**Required Before Deployment:**
- AWS CDK CLI installed and configured
- AWS credentials with permissions for KMS, EC2, ECR
- Latest DLM snapshot available (for migration)
- Maintenance window scheduled (for volume migration)

**External Dependencies:**
- JetBrains YouTrack image (for CVE resolution)
- AWS KMS service availability
- DLM service for snapshot management

## Success Metrics

**Immediate (48 hours):**
- 4 of 5 Security Hub findings resolved
- Zero unplanned downtime
- All functional tests passing

**Short-term (1 week):**
- No volume issues or container restarts
- DLM snapshot succeeded with new KMS key
- ECR lifecycle policy executed first cleanup

**Long-term (1 month):**
- No security finding regressions
- ECR storage optimized (old images removed)
- System stability maintained
- Quarterly CVE review scheduled

## References

- [AWS EC2 IMDSv2 Documentation](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html)
- [AWS KMS Best Practices](https://docs.aws.amazon.com/kms/latest/developerguide/best-practices.html)
- [ECR Lifecycle Policies](https://docs.aws.amazon.com/AmazonECR/latest/userguide/LifecyclePolicies.html)
- [CVE-2016-1000027 Details](https://nvd.nist.gov/vuln/detail/CVE-2016-1000027)
- One.Cloud Security Hub Compliance Requirements
