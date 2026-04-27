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

**Deploy both stacks:**
```bash
cdk deploy YouTrackStack-Local AutomationStack-Local
```

**Deploy individual stack:**
```bash
cdk deploy YouTrackStack-Local
```

**If SSL/CA certificate errors occur:**
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk deploy YouTrackStack-Local AutomationStack-Local
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

**Destroy stack (use with extreme caution):**
```bash
cdk destroy YouTrackStack-Local
```

## YouTrack Image Management

### Pushing New Image to ECR

**One-time setup (run on local machine with Docker):**
```bash
# Use the update script for new versions
./scripts/update-youtrack-image.sh 2026.1.12458

# Or manually:
docker pull jetbrains/youtrack:2026.1.12458
aws ecr get-login-password --region eu-west-1 | \
  docker login --username AWS --password-stdin \
  640664844884.dkr.ecr.eu-west-1.amazonaws.com
docker tag jetbrains/youtrack:2026.1.12458 \
  640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:2026.1.12458
docker push 640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:2026.1.12458
```

**IMPORTANT**: Image push is one-time, NOT part of CDK deployment. Update image in ECR first, then update version in `lib/youtrack-stack.ts`, commit the change, and push to CodeCommit to trigger automatic deployment via the pipeline.

### Accessing Running Instance

**Note:** Instance runs on a schedule (Mon-Fri 7AM-7PM UTC). If instance is stopped, start it manually or wait for the scheduled start time.

```bash
# Get current stack outputs
aws cloudformation describe-stacks --stack-name YouTrackStack --region eu-west-1 --query 'Stacks[0].Outputs'

# Check instance state
aws ec2 describe-instances --instance-ids i-0f9fe3a681f4c1d5a --region eu-west-1 \
  --query 'Reservations[0].Instances[0].State.Name'

# Start instance manually if needed
aws ec2 start-instances --instance-ids i-0f9fe3a681f4c1d5a --region eu-west-1

# Connect via SSM Session Manager
aws ssm start-session --target i-0f9fe3a681f4c1d5a --region eu-west-1

# Port forwarding to access YouTrack UI (use different local port if 8080 busy)
aws ssm start-session --target i-0f9fe3a681f4c1d5a --region eu-west-1 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8080"],"localPortNumber":["8484"]}'
```

Then access YouTrack at `http://localhost:8484` in browser.

## Architecture

### Stack Structure

The infrastructure consists of three CDK stacks deployed in a GitOps workflow:

**1. PipelineStack** (`lib/pipeline-stack.ts`) - Deployed once locally
- CodeCommit repository: `youtrack-infrastructure` (main branch)
- Self-mutating CDK pipeline (can update its own configuration)
- CodeBuild runs in Shared VPC for VPC endpoint access
- Automatically deploys YouTrackStack and AutomationStack on git push
- No environment variables needed (VPC endpoints handle AWS service access)

**2. YouTrackStack** (`lib/youtrack-stack.ts`) - Deployed by pipeline
- EC2 t3.medium instance in eu-west-1a (4GB RAM required - t3.small causes OOM)
- Amazon Linux 2 from image factory (ami-0b434d403262ef6c7)
- Docker container running YouTrack from ECR
- Separate 50GB gp3 EBS data volume mounted at `/var/youtrack-data`
- Volume tagged `Backup: weekly-dlm` for automated snapshots
- Private IP only, port 8080
- SSM Session Manager access (no SSH)

**3. AutomationStack** (`lib/automation-stack.ts`) - Deployed by pipeline
- EventBridge Scheduler for EC2 start/stop (Mon-Fri 7AM-7PM UTC)
- DLM lifecycle policy for weekly EBS snapshots (Friday 6PM UTC, 4 weeks retention)

**Key Components:**
- `SharedVpc`: Imported from `@vwg-community/vws-cdk` (required by SCP)
- Security Group: Allows inbound 8080 from RFC 1918 private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
- IAM Role: SSM managed instance core + ECR read permissions
- UserData: Installs Docker, authenticates to ECR, runs YouTrack container with volume mount

### Docker Container Configuration

**Critical Permissions:**
- YouTrack container runs as UID/GID 13001:13001
- Data directory `/var/youtrack-data` must be owned by 13001:13001
- UserData script sets: `chown -R 13001:13001 /var/youtrack-data` and `chmod -R 755 /var/youtrack-data`

**Image Location:**
- Registry: `640664844884.dkr.ecr.eu-west-1.amazonaws.com`
- Repository: `youtrack`
- Current Version: `2026.1.12458`

### Deprecated Code

Old test code from initial CDK exploration is preserved in `deprecated/cdk-test/` directory. This includes Lambda VPC experiments and S3 integration tests. Do not modify or deploy deprecated code.

## Pipeline Architecture

### GitOps Workflow

The infrastructure uses a self-mutating CDK pipeline for automated deployment:

**Pipeline Stages:**
1. **Source**: CodeCommit repository (`youtrack-infrastructure`, main branch)
2. **Synth**: CodeBuild runs `npm ci`, `npm run build`, `npx cdk synth` in Shared VPC
3. **Self-Update**: Pipeline updates itself if pipeline code changed
4. **Deploy**: Deploys YouTrackStack + AutomationStack

**Key Features:**
- Self-mutation: Pipeline can update its own configuration
- Shared VPC Integration: CodeBuild runs in VPC for endpoint access (no Zscaler issues)
- No environment variables needed: VPC endpoints handle AWS service access
- Automatic deployment on git push to main branch

**Repository:** `youtrack-infrastructure` (CodeCommit)
**Branch:** main
**Region:** eu-west-1
**Account:** 640664844884

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
aws ec2 start-instances --instance-ids i-0f9fe3a681f4c1d5a --region eu-west-1

# Stop instance manually
aws ec2 stop-instances --instance-ids i-0f9fe3a681f4c1d5a --region eu-west-1
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

**Migration Status:** Infrastructure migrated to GitOps workflow on 2026-04-15

**Deployment Method:** Automated via CDK Pipeline
- Pipeline Stack: `PipelineStack`
- Application Stacks: `YouTrackStack`, `AutomationStack` (deployed by pipeline)
- Repository: CodeCommit `youtrack-infrastructure`

**Instance Details** (as of last deployment):
- Stack: YouTrackStack
- Instance ID: i-0f9fe3a681f4c1d5a
- Private IP: 192.168.146.15
- Access URL: http://192.168.146.15:8080 (via SSM port forwarding)
- VPC ID: vpc-05b5078f709cfc904
- Availability Zone: eu-west-1a
- Region: eu-west-1
- Account: 640664844884

**Data Volume:**
- Volume ID: Check stack outputs or EC2 console
- Size: 50GB gp3
- Mount Point: `/var/youtrack-data`
- Backup Tag: `Backup: weekly-dlm`

**Instance Availability:**
- **Business Hours**: Monday-Friday 7AM-7PM UTC (instance running)
- **Off Hours**: Instance automatically stopped (use manual start if needed)

**Costs:**
- EC2 t3.medium: ~$7/month (75% reduction due to scheduling)
- EBS 50GB gp3: ~$4/month
- EBS snapshots: ~$2/month (incremental, 4 weeks retention)
- ECR storage: ~$2/year ($0.10/GB/month x 2GB image)
- **Total: ~$13-14/month** (vs ~$36/month without automation)

See `docs/youtrack-access.md` for detailed access instructions and maintenance procedures.
