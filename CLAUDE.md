# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository contains AWS CDK infrastructure for deploying YouTrack issue tracking on EC2 within Volkswagen's One.Cloud environment. The deployment uses Docker containerization with images stored in AWS ECR, running on a t3.medium EC2 instance within a Shared VPC.

The infrastructure is deployed manually from a local development workstation using AWS CDK. All source code is stored in GitHub to comply with One.Cloud regulations requiring compliant source code providers.

## One.Cloud Constraints

**Critical: All AWS deployments must comply with Service Control Policies (SCPs):**

- **No AWS Marketplace Images**: Only AMIs from the One.Cloud image factory are allowed
- **No Public IP Addresses**: All resources must be deployed in VPC (use PRIVATE_ISOLATED subnets)
- **No SSH Access**: Use SSM Session Manager exclusively for instance access
- **Shared VPC Required**: Must use `@vwg-community/vws-cdk` SharedVpc construct
- **ECR Preferred**: One.Cloud documentation recommends ECR over external registries like Docker Hub

**Network Restrictions:**
- Docker Hub (registry-1.docker.io) is blocked by corporate proxy (Zscaler)
- Use ECR for all container images
- SSL certificate validation issues may require `NODE_TLS_REJECT_UNAUTHORIZED=0`

## Development Commands

### CDK Deployment

**Deploy account setup stacks (one-time):**
```bash
cdk deploy KeyStack-eu-west-1 BootstrapStack-eu-west-1
```

**Deploy application stacks:**
```bash
cdk deploy YouTrackStack AutomationStack
```

**Deploy all stacks:**
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk deploy --all
```

**Deploy individual stack:**
```bash
cdk deploy YouTrackStack
```

**Note:** SSL certificate validation issues may occur due to Zscaler proxy. Use the `NODE_TLS_REJECT_UNAUTHORIZED=0` workaround if you encounter certificate errors.

### Local Development and Testing

```bash
# Synthesize CloudFormation template (for validation)
cdk synth

# Run tests
npm test

# Watch mode
npm run watch
```

### Emergency Manual Deployment

**Destroy application stacks (use with extreme caution):**
```bash
cdk destroy AutomationStack
cdk destroy YouTrackStack

# Note: Never destroy KeyStack or BootstrapStack without understanding the impact
# These stacks provide account-level infrastructure (KMS keys, CDK bootstrap)
```

## YouTrack Image Management

### Upgrading YouTrack

**Use the update script for version upgrades:**
```bash
# Check current ECR state (read-only, no changes)
./scripts/update-youtrack-image.sh --check-only

# Full upgrade: pull from Docker Hub → push to ECR → retag latest → restart container via SSM
./scripts/update-youtrack-image.sh <NEW_VERSION>
# e.g. ./scripts/update-youtrack-image.sh 2026.2.1000
```

The script handles the entire workflow automatically:
1. Checks if the version already exists in ECR (skips pull/push if it does)
2. Pushes the new image to ECR with a version tag and updates `latest`
3. Restarts the container on the EC2 instance via SSM (no manual SSM session needed)

**IMPORTANT**: No code changes or CDK redeployments are needed for version upgrades. The CDK stack uses `:latest` from ECR, so only the script needs to run.

**Dependencies for `--check-only` with Docker Hub comparison:**
- `jq` — JSON parser for Docker Hub API response
  - Install: `yum install jq` (RHEL/Amazon Linux) or `brew install jq` (macOS)
  - Graceful fallback: if jq is missing, script shows ECR state only

### Accessing Running Instance

**Note:** Instance runs on a schedule (Mon-Fri 8AM-7PM UTC). If instance is stopped, start it manually or wait for the scheduled start time.

```bash
# Get current stack outputs
aws cloudformation describe-stacks --stack-name YouTrackStack --region eu-west-1 --query 'Stacks[0].Outputs'

# Check instance state
aws ec2 describe-instances --instance-ids i-07f47d6f9108e5bb6 --region eu-west-1 \
  --query 'Reservations[0].Instances[0].State.Name'

# Start instance manually if needed
aws ec2 start-instances --instance-ids i-07f47d6f9108e5bb6 --region eu-west-1

# Connect via SSM Session Manager
aws ssm start-session --target i-07f47d6f9108e5bb6 --region eu-west-1

# Port forwarding to access YouTrack UI (use different local port if 8080 busy)
aws ssm start-session --target i-07f47d6f9108e5bb6 --region eu-west-1 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8080"],"localPortNumber":["8484"]}'
```

Then access YouTrack at `http://localhost:8484` in browser.

## Architecture

### Stack Structure

The infrastructure follows the One.Cloud account-setup pattern with compliant bootstrap and customer-managed encryption:

**Account Setup Stacks (Generic, Account-Level):**

**1. KeyStack-eu-west-1** (from `@vwg-community/vws-cdk`)
- Customer-managed KMS key (200688f6-a9eb-4c64-a0d7-940b143496cd)
- Single key for all resources (ONE_FOR_ALL_STRATEGY)
- Automatic key rotation enabled (annual)
- Key purpose: CICD (bootstrap S3) and APP_PROD (application resources)
- Aliases: `alias/cicd-key` and `alias/app-prod-key`

**2. BootstrapStack-eu-west-1** (`lib/stacks/bootstrap-stack.ts`)
- CDK bootstrap infrastructure with compliance controls
- Scoped IAM policy replacing AdministratorAccess
- Permissions: cloudformation, cloudwatch, dlm, ec2, ecr, events, iam, kms, lambda, logs, s3, scheduler, serverlessrepo, ssm
- Bootstrap S3 bucket encrypted with customer-managed KMS key
- Includes CDK bootstrap template with custom parameters

**Application Stacks (YouTrack-Specific):**

**3. YouTrackStack** (`lib/youtrack-stack.ts`)
- EC2 t3.medium instance (4GB RAM required - t3.small causes OOM)
- Amazon Linux 2 from image factory (ami-0b434d403262ef6c7)
- Docker container running YouTrack from ECR
- Separate 50GB gp3 EBS data volume mounted at `/var/youtrack-data`
- Volume tagged `Backup: weekly-dlm` for automated snapshots
- Private IP only, port 8080
- SSM Session Manager access (no SSH)
- IMDSv2 enforced (requireImdsv2: true)
- Root and data volumes encrypted with customer-managed KMS key (APP_PROD)
- CloudWatch Logs encrypted with customer-managed KMS key (APP_PROD)

**4. AutomationStack** (`lib/automation-stack.ts`)
- EventBridge Scheduler for EC2 start/stop (Mon-Fri 07:00-19:00 UTC)
- DLM lifecycle policy for weekly EBS snapshots (Friday 19:30 UTC, 4 weeks retention)

**Key Components:**
- `SharedVpc`: Imported from `@vwg-community/vws-cdk` (required by SCP)
- Security Group: Allows inbound 8080 from RFC 1918 private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
- IAM Role: SSM managed instance core + ECR read permissions
- UserData: Installs Docker, authenticates to ECR, runs YouTrack container with volume mount

### Docker Container Configuration

**Volume Mounts (all 4 required):**
- `/var/youtrack-data/data` → `/opt/youtrack/data` (database, application data)
- `/var/youtrack-data/conf` → `/opt/youtrack/conf` (configuration files)
- `/var/youtrack-data/logs` → `/opt/youtrack/logs` (application logs)
- `/var/youtrack-data/backups` → `/opt/youtrack/backups` (internal backups)

**Critical:** All 4 directories must be persisted to EBS. Missing any directory (especially conf) will cause YouTrack to show setup wizard on instance replacement, losing configuration and database connection.

**Permissions:**
- YouTrack container runs as UID/GID 13001:13001
- Data directory `/var/youtrack-data` must be owned by 13001:13001
- UserData script sets: `chown -R 13001:13001 /var/youtrack-data` and `chmod -R 755 /var/youtrack-data`

**Image Location:**
- Registry: `640664844884.dkr.ecr.eu-west-1.amazonaws.com`
- Repository: `youtrack`
- Tag: `:latest` (deployed version determined by ECR image tag, not code version)

### Deprecated Code

Old test code from initial CDK exploration is preserved in `deprecated/cdk-test/` directory. This includes Lambda VPC experiments and S3 integration tests. Do not modify or deploy deprecated code.

## Automation

### EC2 Instance Schedule

**Purpose:** Cost optimization - instance only runs during business hours

**Schedule:**
- **Start**: Monday-Friday at 07:00 UTC (7 AM WET / 8 AM WEST)
- **Stop**: Monday-Friday at 19:00 UTC (7 PM WET / 8 PM WEST)

**Note:** Uses fixed UTC times. Approximately 1 hour shift during DST transitions (WET/WEST) is acceptable for dev environment.

**Cost Impact:** Approximately 75% reduction in EC2 costs (12 hrs/day x 5 days/week vs 24/7)

**Manual Override:**
```bash
# Start instance manually if needed outside business hours
aws ec2 start-instances --instance-ids i-0535d4cb73b266680 --region eu-west-1

# Stop instance manually
aws ec2 stop-instances --instance-ids i-0535d4cb73b266680 --region eu-west-1
```

### EBS Snapshot Backups

**Purpose:** Data protection and disaster recovery

**Schedule:** Weekly on Friday at 18:00 UTC (6 PM WET / 7 PM WEST)
**Retention:** Last 4 snapshots (4 weeks of history)
**Target:** EBS volumes tagged `Backup: weekly-dlm`
**Data Volume:** 50GB YouTrack data volume (`/var/youtrack-data`)

**Benefits:**
- Automated weekly backups
- Point-in-time recovery (up to 4 weeks back)
- Snapshots are incremental (cost-efficient)
- Data persists independently of instance lifecycle

**Restoring from Snapshot:**
```bash
# List available snapshots
aws ec2 describe-snapshots --owner-ids 640664844884 --region eu-west-1 \
  --filters "Name=tag:Backup,Values=weekly-dlm" \
  --query 'Snapshots | sort_by(@, &StartTime) | [-4:].[SnapshotId, StartTime, VolumeSize]'

# Create volume from snapshot (replace snap-xxxxx with actual snapshot ID)
aws ec2 create-volume --snapshot-id snap-xxxxx --availability-zone eu-west-1a \
  --volume-type gp3 --region eu-west-1

# Attach volume to instance (replace vol-xxxxx with new volume ID)
# Note: Stop instance first, detach old volume, attach new volume, start instance
```

## Security Compliance

### Encryption at Rest

**Customer-Managed KMS Key:**
- Key ID: 200688f6-a9eb-4c64-a0d7-940b143496cd
- Aliases: `alias/cicd-key` (bootstrap), `alias/app-prod-key` (application)
- Key rotation: Enabled (annual automatic rotation)
- Strategy: ONE_FOR_ALL_STRATEGY (single key for all resources)

**EBS Volumes:**
- Root volume (/dev/xvda, 30GB): Encrypted with customer-managed KMS key (APP_PROD)
- Data volume (/dev/sdf, 50GB): Encrypted with customer-managed KMS key (APP_PROD)

**S3 Bootstrap Bucket:**
- Bucket: cdk-hnb659fds-assets-640664844884-eu-west-1
- Encryption: Customer-managed KMS key (CICD)

**CloudWatch Logs:**
- Log Group: /aws/ssm/YouTrack
- Encryption: Customer-managed KMS key (APP_PROD)

**ECR Repository:**
- Repository: youtrack
- Encryption: AES-256 (AWS-managed, cannot be changed after creation)
- Lifecycle Policy: Keep last 3 tagged images, remove untagged after 7 days

**EBS Snapshots:**
- Inherit encryption from source volume (customer-managed KMS key)
- DLM policy encrypts all snapshots automatically
- Retention: 4 weeks (28 days)

### Instance Metadata Service

**IMDSv2 Enforcement:**
- Configuration: `requireImdsv2: true` in YouTrackStack
- Protects against SSRF attacks to metadata service
- Hop limit: 1 (default, prevents forwarding from containers)

**Impact:**
- Legacy IMDSv1 requests are rejected
- Applications must use session-oriented IMDSv2 (PUT token request, then GET with token)
- Docker containers can access metadata (hop limit allows)

### Network Isolation

**VPC Configuration:**
- Subnet Type: PRIVATE_ISOLATED (no internet gateway, no NAT gateway)
- No public IP addresses (enforced by One.Cloud SCP)
- VPC Endpoints: Not required (SSM uses AWS PrivateLink automatically)

**Security Group Rules:**
- Inbound: Port 8080 from RFC 1918 private ranges only
  - 10.0.0.0/8
  - 172.16.0.0/12
  - 192.168.0.0/16
- Outbound: All traffic allowed (required for yum updates, ECR pulls, SSM)

**Access Methods:**
- SSM Session Manager: ONLY permitted access method (no SSH, no direct network access)
- Port Forwarding: Via SSM for local browser access to YouTrack UI

### IAM Permissions

**EC2 Instance Role:**
- Managed Policy: AmazonSSMManagedInstanceCore (SSM access)
- Inline Policy: ECR read-only (GetAuthorizationToken, BatchCheckLayerAvailability, GetDownloadUrlForLayer, BatchGetImage)
- No S3 access, no RDS access, no secrets access

**Principle of Least Privilege:**
- Instance can ONLY:
  - Connect to SSM for management
  - Pull Docker images from ECR
  - Write logs to CloudWatch (via SSM agent)
- Instance CANNOT:
  - Access other AWS services
  - Assume other IAM roles
  - Read/write S3 buckets
  - Access secrets or parameters

### Compliance Tags

**Required Tags (applied to all resources):**
- Environment: production
- Project: YouTrack
- ManagedBy: CDK
- Owner: a2i5giv
- Purpose: Issue-Tracking

**Backup Tags:**
- Backup: weekly-dlm (on data volume and snapshots)

### Compliance Findings Resolution

**Deployment Date:** 2026-04-30

All One.Cloud compliance findings have been resolved by adopting the account-setup template pattern:

**✅ IAM AdministratorAccess (eu-west-1):**
- **Finding ID**: 42b336cc-dec5-4487-bf65-bff12953eb95
- **Status**: RESOLVED
- **Solution**: Created BootstrapStack with scoped IAM policy `CdkBootstrap-hnb659fds-eu-west-1`
- **Permissions**: cloudformation, cloudwatch, dlm, ec2, ecr, events, iam, kms, lambda, logs, s3, scheduler, serverlessrepo, ssm
- **Verification**: `aws iam list-attached-role-policies --role-name cdk-hnb659fds-cfn-exec-role-640664844884-eu-west-1 --region eu-west-1`

**⚠️ IAM AdministratorAccess (us-east-1):**
- **Finding ID**: 40a19828-e06c-4f62-b5ae-1443ca5e82f0
- **Status**: SKIPPED (SCP restrictions prevent us-east-1 operations)
- **Note**: us-east-1 bootstrap not deployed due to S3 bucket deletion restrictions

**✅ S3 AWS-managed KMS Key:**
- **Finding ID**: 7bd21bbc-6f36-4b29-bd40-0e2212387904
- **Status**: RESOLVED
- **Solution**: Bootstrap S3 bucket now uses customer-managed KMS key (200688f6)
- **Bucket**: cdk-hnb659fds-assets-640664844884-eu-west-1
- **Verification**: `aws s3api get-bucket-encryption --bucket cdk-hnb659fds-assets-640664844884-eu-west-1 --region eu-west-1`

**✅ ECR Lifecycle Policy Missing:**
- **Finding ID**: 53736dfe-c67b-4e6c-bafc-c489ba20cc31
- **Status**: RESOLVED
- **Solution**: Applied lifecycle policy via AWS CLI (ecr-lifecycle-policy.json)
- **Policy**: Keep last 3 tagged images (2026*), remove untagged after 7 days
- **Verification**: `aws ecr get-lifecycle-policy --repository-name youtrack --region eu-west-1`

### Known Security Findings

**CVE-2016-1000027 (Spring Framework):**
- Status: ACCEPTED RISK
- Severity: CRITICAL (CVSS 9.8)
- Component: Spring Framework in YouTrack vendor container
- Justification: Vendor-managed container, no patch available, strong network isolation
- Compensating Controls: PRIVATE_ISOLATED subnet, no public IP, RFC 1918 ingress only, IMDSv2, SSM-only access
- Documentation: `docs/security-exceptions.md`
- Review Date: 2027-04-27 (annual)

**Risk Level:** MEDIUM (HIGH impact, LOW exploitability due to network controls)

### Security Monitoring

**CloudWatch Logs:**
- SSM Session Manager logs (interactive sessions, port forwarding)
- Instance system logs (console output, system messages)

**Audit Trail:**
- All SSM sessions logged to CloudWatch
- IAM role usage tracked via CloudTrail
- EBS snapshot creation logged via EventBridge

**Alerting:**
- None configured (development environment)
- Manual review recommended quarterly

### Security Best Practices

**Operational Security:**
1. Review SSM session logs monthly for anomalous access
2. Verify encryption keys are active and not pending deletion
3. Test snapshot restore procedure quarterly
4. Review security group rules for unauthorized changes
5. Validate IMDSv2 enforcement has not been disabled

**Incident Response:**
1. If compromise suspected: Stop instance immediately
2. Create forensic snapshot of volumes before any changes
3. Review CloudWatch logs for SSM session activity
4. Check CloudTrail for IAM role usage
5. Restore from known-good snapshot if needed

**Vulnerability Management:**
1. Monitor JetBrains security advisories for YouTrack updates
2. Review NVD for new CVEs affecting Spring Framework quarterly
3. Check CISA KEV catalog for known exploited vulnerabilities
4. Update `docs/security-exceptions.md` with any new findings
5. Plan remediation if new HIGH/CRITICAL vulnerabilities are discovered

## Common Issues and Solutions

### YouTrack Out of Memory
- **Symptom**: Container restarts, "insufficient memory for Java Runtime" errors
- **Cause**: t3.small (2GB RAM) insufficient for YouTrack 2026.1+
- **Solution**: Use t3.medium (4GB RAM) minimum

### Docker Container Permission Denied
- **Symptom**: "directory /opt/youtrack/data is not writable"
- **Cause**: Data directory not owned by UID 13001
- **Solution**: UserData script includes `chown -R 13001:13001 /var/youtrack-data`

### Cannot Pull from Docker Hub
- **Symptom**: "TLS handshake timeout" or "dial tcp: lookup registry-1.docker.io"
- **Cause**: Zscaler proxy blocks Docker Hub
- **Solution**: Always use ECR for container images, not Docker Hub

### SSM Port Forwarding Stuck
- **Symptom**: Cannot access YouTrack at localhost:8080
- **Cause**: Port 8080 already in use on local machine
- **Solution**: Use different local port (e.g., 8484): `--parameters '{"portNumber":["8080"],"localPortNumber":["8484"]}'`

### CDK Deploy SSL Errors
- **Symptom**: "unable to verify the first certificate"
- **Cause**: Zscaler SSL interception
- **Solution**: Set `NODE_TLS_REJECT_UNAUTHORIZED=0` environment variable

## Current Deployment

**Migration Status:** 
- 2026-04-27: Infrastructure migrated from CodeCommit to GitHub
- 2026-04-30: Adopted account-setup pattern for compliance

**Deployment Method:** Manual CDK deployment from local workstation
- Account Setup: `KeyStack-eu-west-1`, `BootstrapStack-eu-west-1`
- Application Stacks: `YouTrackStack`, `AutomationStack`
- Repository: GitHub `https://github.com/vwChumbo/YouTrack.git`

**Compliance Note:** GitHub is used as the source code provider to comply with One.Cloud regulations. CodeCommit is not permitted for source code storage.

**Instance Details** (as of 2026-04-30):
- Stack: YouTrackStack
- Instance ID: i-07f47d6f9108e5bb6
- Private IP: 192.168.155.2
- Access URL: http://192.168.155.2:8080 (via SSM port forwarding)
- VPC ID: vpc-05b5078f709cfc904
- Region: eu-west-1
- Account: 640664844884

**Security Configuration:**
- IMDSv2: Enforced (requireImdsv2: true)
- Root Volume: 30GB gp3, encrypted with customer-managed KMS key (APP_PROD)
- Data Volume: 50GB gp3, encrypted with customer-managed KMS key (APP_PROD)
- KMS Key ID: 200688f6-a9eb-4c64-a0d7-940b143496cd
- KMS Key Aliases: alias/cicd-key, alias/app-prod-key
- KMS Key Rotation: Enabled (annual automatic)

**Data Volume:**
- Volume ID: Check stack outputs or EC2 console
- Size: 50GB gp3
- Mount Point: `/var/youtrack-data`
- Subdirectories: data, conf, logs, backups (all 4 required volumes)
- Backup Tag: `Backup: weekly-dlm`
- Encryption: Customer-managed KMS key

**Instance Availability:**
- **Business Hours**: Monday-Friday 07:00-19:00 UTC (instance running)
  - Winter (WET): 7AM-7PM Lisbon time
  - Summer (WEST): 8AM-8PM Lisbon time (1 hour shift)
- **Off Hours**: Instance automatically stopped (use manual start if needed)

**Costs:**
- EC2 t3.medium: ~$7/month (75% reduction due to scheduling)
- EBS 50GB gp3: ~$4/month
- EBS snapshots: ~$2/month (incremental, 4 weeks retention)
- CloudWatch Logs: <$1/month (SSM session logs, 1-year retention)
- KMS key: $1/month (single customer-managed key for all resources)
- **Total: ~$14-15/month** (vs ~$36/month without automation)

See `docs/youtrack-access.md` for detailed access instructions and maintenance procedures.
