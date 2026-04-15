# YouTrack Infrastructure Pipeline Design

**Date:** 2026-04-15  
**Status:** Approved  
**Purpose:** Migrate YouTrack infrastructure from manual CDK deployments to automated GitOps pipeline with cost optimization

## Context

Currently, the YouTrack infrastructure is deployed manually using local CDK commands. This approach requires:
- Developer workstation with AWS credentials configured
- Manual deployment for every infrastructure change
- No version control integration
- EC2 instance running 24/7, incurring unnecessary costs

This design transitions to a GitOps model where all infrastructure changes flow through CodeCommit and are automatically deployed via a self-mutating CDK pipeline. Additionally, we're improving the architecture with:
- Separate EBS volume for data (enabling clean backups)
- Automated EC2 start/stop schedules (reducing costs by 75%)
- Weekly snapshot backups with retention policy
- Explicit availability zone placement for predictable resource location

## Architecture Overview

### Self-Mutating CDK Pipeline

Three CDK stacks working together:

1. **PipelineStack** (deployed once locally, then self-manages)
   - CodeCommit repository: `youtrack-infrastructure`
   - CDK Pipeline with stages: Source → Synth → Self-Update → Deploy

2. **YouTrackStack** (deployed by pipeline)
   - EC2 t3.medium in eu-west-1a
   - Separate 50GB EBS volume for YouTrack data
   - Security group, IAM role, Docker setup with ECR image

3. **AutomationStack** (deployed by pipeline)
   - EventBridge schedules for start/stop (Mon-Fri, 7 AM - 7 PM Lisbon time)
   - DLM policy for weekly snapshots (Friday 6 PM, retain 4 weeks)

### Deployment Flow

```
Initial setup (one-time):
  Local → cdk deploy PipelineStack → Creates CodeCommit + Pipeline

Ongoing workflow:
  Developer → git push codecommit main → Pipeline auto-deploys all changes
```

## Stack Breakdown

### PipelineStack Resources

**CodeCommit Repository:**
- Name: `youtrack-infrastructure`
- Description: "AWS CDK infrastructure for YouTrack issue tracking deployment"
- Initial content: Push current local repo

**CDK Pipeline:**
- Source: CodeCommit `youtrack-infrastructure` main branch
- Build: CodeBuild project in Shared VPC
  - Environment: Amazon Linux 2 standard image
  - VPC: Shared VPC (PRIVATE_ISOLATED subnets) for VPC endpoint access
  - Commands: `npm ci`, `npm run build`, `npx cdk synth`
  - Note: No Zscaler workarounds needed (VPC endpoints handle AWS service access)
- Stages:
  1. Self-mutate (updates pipeline if pipeline code changed)
  2. Deploy YouTrackStack
  3. Deploy AutomationStack

### YouTrackStack Resources

**EC2 Instance:**
- Type: t3.medium (4GB RAM required for YouTrack 2026.1+)
- AMI: Amazon Linux 2 from One.Cloud image factory (ami-0b434d403262ef6c7)
- Availability Zone: eu-west-1a (explicit placement)
- VPC: Shared VPC, PRIVATE_ISOLATED subnet in eu-west-1a
- Root volume: 30GB gp3 (OS only)

**Data EBS Volume:**
- Size: 50GB gp3
- Availability Zone: eu-west-1a (must match EC2)
- Encrypted: Yes (AWS managed key)
- Device: /dev/sdf
- Mount point: `/var/youtrack-data`
- Tags: `Name: youtrack-data`, `Backup: weekly-dlm`

**Security Group:**
- Inbound: Port 8080 from RFC 1918 private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
- Outbound: All traffic (for ECR access via VPC endpoint)

**IAM Role:**
- Managed policies: `AmazonSSMManagedInstanceCore`
- Inline policy: ECR read access (GetAuthorizationToken, BatchGetImage, GetDownloadUrlForLayer)

**UserData Script:**
1. Install Docker
2. Create mount point `/var/youtrack-data`
3. Format EBS volume as ext4 (if not already formatted)
4. Mount EBS volume with fstab entry for persistence
5. Set ownership: `chown -R 13001:13001 /var/youtrack-data`
6. Set permissions: `chmod -R 755 /var/youtrack-data`
7. Login to ECR (640664844884.dkr.ecr.eu-west-1.amazonaws.com)
8. Pull YouTrack image: `youtrack:2026.1.12458`
9. Run container with volume mount: `-v /var/youtrack-data:/opt/youtrack/data`

### AutomationStack Resources

**EventBridge Schedules:**
- **Start Schedule:**
  - Cron: Mon-Fri at 07:00 UTC (handles Lisbon time WET/WEST with ~1hr variance during DST)
  - Target: EC2 StartInstances API
  - Target instance: Reference from YouTrackStack output
  
- **Stop Schedule:**
  - Cron: Mon-Fri at 19:00 UTC
  - Target: EC2 StopInstances API
  - Target instance: Reference from YouTrackStack output

**DLM Lifecycle Policy:**
- Name: `youtrack-weekly-backups`
- Target: EBS volumes tagged `Backup: weekly-dlm`
- Schedule: Weekly on Friday at 18:00 UTC (~6 PM Lisbon time)
- Retention: Keep last 4 snapshots (4 weeks of history)
- Copy tags: Yes (inherits volume tags)
- Cross-region copy: No (same region sufficient)

## One.Cloud Compliance

### SCP Requirements Met

- ✅ **No Public IPs**: All resources in PRIVATE_ISOLATED subnets
- ✅ **No SSH**: SSM Session Manager only
- ✅ **Shared VPC**: Using `@vwg-community/vws-cdk` SharedVpc construct
- ✅ **ECR over Docker Hub**: All images from ECR (Docker Hub blocked by Zscaler)
- ✅ **One.Cloud AMI**: Using image factory AMI, not AWS Marketplace

### Network Configuration

**Shared VPC Features:**
- Pre-configured VPC endpoints for AWS services (CodeCommit, ECR, S3, SSM, etc.)
- VWS Proxy service for outbound internet access
- Allowed domains without proxy: `*.amazonaws.com`, `*.ecr.aws`, `*.vwgroup.com`
- No uptime guarantees (suitable for dev/test workloads)

**Zscaler Handling:**
- Corporate laptops: `NODE_TLS_REJECT_UNAUTHORIZED=0` needed for local CDK commands
- CodeBuild: No workaround needed (VPC endpoints bypass proxy)

### Troubleshooting Note

If we encounter SCP violations or strange restrictions during implementation, analyze the `@vwg-community/vws-cdk` package for One.Cloud-specific primitives or wrappers. This package contains constructs specifically designed for One.Cloud constraints:

```bash
# Inspect available constructs
npm list @vwg-community/vws-cdk
cat node_modules/@vwg-community/vws-cdk/lib/index.d.ts
```

May provide solutions for:
- CodeBuild configurations optimized for Shared VPC
- EventBridge schedules with proper IAM permissions
- DLM policies that comply with SCPs
- Other AWS service integrations adapted for One.Cloud

## Data Flow

### Initial Deployment

1. Developer deploys PipelineStack locally (one-time):
   ```bash
   NODE_TLS_REJECT_UNAUTHORIZED=0 cdk deploy PipelineStack
   ```

2. Push code to CodeCommit:
   ```bash
   git remote add codecommit <url-from-output>
   git push codecommit main
   ```

3. Pipeline executes automatically:
   - Source: Checkout code from CodeCommit
   - Synth: CodeBuild runs `cdk synth` in Shared VPC
   - Self-Update: Pipeline updates itself if pipeline code changed
   - Deploy: CloudFormation deploys YouTrackStack and AutomationStack

### Normal Development Workflow

```
Developer makes changes locally
  ↓
git commit and push to main
  ↓
CodeCommit triggers pipeline
  ↓
CodeBuild synthesizes in Shared VPC
  ↓
Pipeline self-updates (if needed)
  ↓
Pipeline deploys stacks
  ↓
Infrastructure updated in AWS
```

### YouTrack Container Lifecycle

**Startup (via UserData):**
```
EC2 boots → UserData runs:
1. Install Docker
2. Mount EBS at /var/youtrack-data
3. Set permissions (UID 13001)
4. Login to ECR
5. Pull youtrack:2026.1.12458
6. Run container with volume mount
```

**Data Persistence:**
- YouTrack writes to `/opt/youtrack/data` (container path)
- Mounted from `/var/youtrack-data` (EBS volume)
- Data survives:
  - Container restarts
  - EC2 stop/start cycles
  - Stack updates (EBS retention policy can preserve volume)

**Automated Lifecycle:**
```
Monday 7 AM:    Start EC2 → UserData runs → YouTrack available
Monday-Friday:  Running during business hours
Friday 7 PM:    Stop EC2 → Container stops gracefully → Data persists on EBS
Friday 6 PM:    DLM creates snapshot (before stop)
Weekend:        EC2 stopped, data on EBS, snapshot stored separately
```

### Version Updates

**To update YouTrack version:**

1. Push new image to ECR:
   ```bash
   ./scripts/update-youtrack-image.sh 2026.2.XXXXX
   ```

2. Update image tag in `lib/youtrack-stack.ts`

3. Commit and push:
   ```bash
   git commit -am "feat: upgrade YouTrack to 2026.2.XXXXX"
   git push codecommit main
   ```

4. Pipeline automatically deploys updated stack

5. CloudFormation replaces EC2 instance with new UserData (new image version)

6. Data persists on EBS volume through the update

## Error Handling

### Pipeline Failures

**Build Failures:**
- TypeScript compilation errors → Build fails, no deployment
- CDK synth errors → Build fails, no deployment
- Test failures → Build fails, no deployment
- CloudWatch Logs capture full build output

**Deployment Failures:**
- CloudFormation rollback on stack update failures
- Previous working version remains deployed
- Stack events in CloudFormation console show failure reason

**Common Issues:**
- SCP violations → Check @vwg-community/vws-cdk constructs
- Resource limits → Check account quotas
- Shared VPC subnet exhaustion → May need capacity request
- Cross-AZ resource placement → Ensure EC2 and EBS both in eu-west-1a

### Resource Failures

**EC2 UserData Failures:**
- Logged to `/var/log/cloud-init-output.log`
- Docker installation failure → Stack deploys but container doesn't run
- EBS mount failure → YouTrack can't start
- ECR login failure → Can't pull image
- **Mitigation**: UserData script includes error checking, exits on failure

**EBS Volume Issues:**
- Must be in same AZ as EC2 (enforced in CDK code)
- Attachment failures → Stack rollback
- Mount failures → UserData fails
- **Recovery**: Manual snapshot restore if volume corrupts

**EventBridge Schedule Failures:**
- Start/stop failures → Instance may stay in wrong state
- **Monitoring**: CloudWatch Logs for schedule execution
- **Mitigation**: EventBridge retries failed invocations

**DLM Snapshot Failures:**
- Creation failures logged to CloudWatch
- **Verification**: Check "Lifecycle Manager" console
- **Mitigation**: Tagged resources automatically included

### Timezone Handling

**Challenge:** Lisbon uses WET (UTC+0) in winter and WEST (UTC+1) in summer.

**Solution:** EventBridge doesn't support timezone-aware cron expressions. We use fixed UTC schedules:
- Start: 07:00 UTC → 7 AM WET / 8 AM WEST
- Stop: 19:00 UTC → 7 PM WET / 8 PM WEST
- Snapshot: 18:00 UTC → 6 PM WET / 7 PM WEST

**Impact:** ~1 hour shift during DST transitions is acceptable for dev environment.

**Alternative (more complex):** Dual schedules with date ranges for WET/WEST periods. Not recommended unless strict timing required.

## Testing & Verification

### Pre-Deployment Testing (Local)

```bash
npm run build    # TypeScript compilation
npm test         # Jest unit tests
cdk synth        # Validate CDK code
cdk diff         # Preview changes
```

### Post-Deployment Verification

**1. Verify EC2 Instance:**
```bash
aws ec2 describe-instances --region eu-west-1 \
  --filters "Name=tag:aws:cloudformation:stack-name,Values=YouTrackStack" \
  --query 'Reservations[0].Instances[0].[InstanceId,State.Name,Placement.AvailabilityZone]'
```

Expected: Instance running in eu-west-1a

**2. Verify EBS Volume:**
```bash
# Connect via SSM
aws ssm start-session --target <instance-id> --region eu-west-1

# Inside instance
df -h | grep youtrack-data
lsblk
ls -la /var/youtrack-data
```

Expected: 50GB volume mounted at `/var/youtrack-data`, owned by 13001:13001

**3. Verify Docker Container:**
```bash
docker ps | grep youtrack
docker logs youtrack
```

Expected: Container running, logs show YouTrack startup

**4. Verify YouTrack Access:**
```bash
# From local machine
aws ssm start-session --target <instance-id> --region eu-west-1 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8080"],"localPortNumber":["8484"]}'
```

Access http://localhost:8484 in browser
Expected: YouTrack setup wizard or login page

**5. Verify Automation Resources:**
```bash
# EventBridge schedules
aws scheduler list-schedules --region eu-west-1 | grep youtrack

# DLM policies
aws dlm get-lifecycle-policies --region eu-west-1
```

Expected: 2 schedules (start/stop), 1 DLM policy

**6. Verify First Automated Cycle:**
- Monitor first stop (Friday 7 PM)
- Monitor first start (Monday 7 AM)
- Verify first snapshot (Friday 6 PM)
- After 5 weeks, verify oldest snapshot deleted (retention working)

## Migration from Current Deployment

### Pre-Migration Steps

**1. Backup Current Data:**
```bash
# Get current instance volume ID
aws ec2 describe-instances --instance-ids i-0f9fe3a681f4c1d5a --region eu-west-1 \
  --query 'Reservations[0].Instances[0].BlockDeviceMappings'

# Create manual snapshot
aws ec2 create-snapshot \
  --volume-id <current-root-volume-id> \
  --description "Pre-migration YouTrack backup $(date +%Y-%m-%d)" \
  --region eu-west-1
```

**2. Document Current State:**
- Note current instance ID: i-0f9fe3a681f4c1d5a
- Note current private IP: 192.168.146.15
- Export YouTrack configuration (if needed)

### Migration Execution

**1. Deploy Pipeline Stack (local, one-time):**
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk deploy PipelineStack
```

**2. Add CodeCommit Remote:**
```bash
# Get URL from stack output
git remote add codecommit <codecommit-clone-url-http>
```

**3. Push Code to Trigger Pipeline:**
```bash
git push codecommit main
```

**4. Monitor Pipeline Execution:**
- Open CodePipeline console
- Watch Source → Synth → Update → Deploy stages
- Check CloudFormation for stack creation progress

**5. Verify New Deployment:**
- Get new instance ID from stack outputs
- Test access via SSM port forwarding
- Complete YouTrack setup wizard
- Test basic functionality (create project, add issue)

**6. Destroy Old Stack:**
```bash
# After confirming new deployment works
cdk destroy YouTrackStack
```

This removes old EC2 instance (ID: i-0f9fe3a681f4c1d5a)

**7. Optional: Restore Data from Backup**

If you need to migrate data from old instance:

```bash
# Create volume from pre-migration snapshot
aws ec2 create-volume \
  --snapshot-id <snapshot-id> \
  --availability-zone eu-west-1a \
  --region eu-west-1

# Attach to new instance
aws ec2 attach-volume \
  --volume-id <new-volume-id> \
  --instance-id <new-instance-id> \
  --device /dev/sdg \
  --region eu-west-1

# Inside new instance via SSM
sudo mkdir /mnt/old-data
sudo mount /dev/sdg1 /mnt/old-data
sudo cp -a /mnt/old-data/var/youtrack-data/* /var/youtrack-data/
sudo chown -R 13001:13001 /var/youtrack-data
docker restart youtrack
```

## Cost Analysis

### Current State (Manual Deployment)
- EC2 t3.medium running 24/7: ~$30/month
- Root volume 30GB: ~$2.40/month
- **Total: ~$32/month**

### New State (Automated Pipeline)
- EC2 t3.medium (12 hrs/day × 5 days/week = 25% utilization): ~$7.50/month
- Root volume 30GB: ~$2.40/month
- Data volume 50GB gp3: ~$4/month
- EBS snapshots (4 × 50GB incremental): ~$10/month
- CodeCommit: Free (< 5 users, < 50GB)
- CodeBuild: ~$0.50/build (minimal monthly cost)
- CodePipeline: $1/month
- Shared VPC data transfer: First 100GB free
- **Total: ~$25/month**

### Savings
- Monthly savings: ~$7/month
- Annual savings: ~$84/year
- Cost reduction: 22% (primarily from EC2 automation)

### Cost Optimization Notes
- 75% reduction in EC2 runtime (24/7 → 12hrs/day × 5 days)
- Snapshot costs may be lower due to incremental nature
- Additional benefit: Predictable infrastructure-as-code maintenance

## Security Considerations

### Network Security
- ✅ No public IPs → All access via SSM Session Manager
- ✅ Security group restricts port 8080 to private RFC 1918 ranges
- ✅ VPC endpoints for AWS service communication (no internet gateway)
- ✅ Outbound traffic via VWS Proxy service

### Access Control
- ✅ EC2 instance role: Least privilege (SSM + ECR read only)
- ✅ No SSH keys → No key management burden
- ✅ Pipeline IAM role: Deploy permissions for CloudFormation, EC2, DLM
- ⚠️ YouTrack admin credentials: Set during initial setup, stored in YouTrack DB

### Data Protection
- ✅ EBS encryption at rest (AWS managed keys)
- ✅ Snapshots inherit encryption from source volume
- ✅ Data only accessible from within VPC or via SSM port forwarding
- ✅ Weekly snapshots provide point-in-time recovery (4 weeks retention)

### Pipeline Security
- ✅ CodeCommit IAM authentication (no public access)
- ✅ CodeBuild isolated in Shared VPC (no direct internet access)
- ✅ Pipeline execution in AWS account (no external CI/CD)

### Future Enhancements
- Consider AWS Secrets Manager for YouTrack admin password
- Enable CloudTrail logging for audit trail
- Add SNS notifications for pipeline failures and security events
- Implement CloudWatch alarms for anomalous access patterns

## Future Roadmap

### Phase 1: Current Design (This Implementation)
- ✅ Version control with CodeCommit
- ✅ Automated deployment via self-mutating CDK pipeline
- ✅ Separate EBS data volume (50GB)
- ✅ Automated start/stop schedules (Mon-Fri, 7 AM - 7 PM)
- ✅ Weekly EBS snapshots (Friday 6 PM, 4 weeks retention)
- ✅ One.Cloud SCP compliance

### Phase 2: Observability & Reliability
- CloudWatch alarms:
  - EC2 instance health (StatusCheckFailed)
  - EBS disk usage (> 80% full)
  - Schedule execution failures
  - Snapshot creation failures
- SNS notifications for alarms
- CloudWatch dashboard for YouTrack metrics
- Automated restoration testing (monthly snapshot restore to test instance)

### Phase 3: Multi-Environment Support
- Separate stacks for dev/staging/prod
- Environment-specific configurations (instance size, schedules, retention)
- Cross-environment promotion workflow
- Environment-specific IAM roles and permissions

### Phase 4: High Availability (If Required)
- Multi-AZ deployment with EFS instead of EBS
- Application Load Balancer for better access
- Auto-scaling group (single instance for now, can scale later)
- RDS for YouTrack database (if YouTrack supports external DB)
- Container orchestration with ECS/Fargate

## Critical Files

- `lib/pipeline-stack.ts` - Pipeline definition (NEW)
- `lib/youtrack-stack.ts` - EC2, EBS, security group (MODIFIED)
- `lib/automation-stack.ts` - EventBridge schedules, DLM (NEW)
- `bin/onecloud.ts` - App entry point (MODIFIED to add new stacks)
- `scripts/update-youtrack-image.sh` - ECR image update helper (EXISTING)
- `CLAUDE.md` - Project documentation (UPDATE with new workflow)

## Success Criteria

**Deployment Success:**
- ✅ PipelineStack deploys successfully (one-time local deployment)
- ✅ Code pushed to CodeCommit triggers pipeline
- ✅ Pipeline self-updates when pipeline code changes
- ✅ YouTrackStack deploys via pipeline (no local deployment)
- ✅ AutomationStack deploys via pipeline

**Infrastructure Success:**
- ✅ EC2 instance running in eu-west-1a
- ✅ EBS volume (50GB) attached and mounted at `/var/youtrack-data`
- ✅ YouTrack container running with ECR image
- ✅ YouTrack accessible via SSM port forwarding
- ✅ EventBridge schedules created and functional
- ✅ DLM policy created and generating snapshots

**Operational Success:**
- ✅ First automated stop/start cycle completes successfully
- ✅ First snapshot created on Friday 6 PM
- ✅ Snapshot retention working (oldest deleted after 4 weeks)
- ✅ YouTrack data persists across stop/start cycles
- ✅ Cost reduction achieved (EC2 only running business hours)

**GitOps Success:**
- ✅ All infrastructure changes flow through git push
- ✅ No local CDK deployments needed after initial setup
- ✅ Pipeline self-updates when pipeline code changes
- ✅ Failed builds prevent deployment of broken code
