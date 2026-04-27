# Deployment Checklist

This document provides step-by-step deployment procedures for the YouTrack infrastructure on One.Cloud. Follow this checklist carefully to ensure safe and successful deployments.

## Pre-Deployment Validation

### 1. Code Review and Testing

- [ ] All code changes have been committed to git
- [ ] Git working tree is clean (`git status` shows no uncommitted changes)
- [ ] Code builds successfully (`npm run build`)
- [ ] TypeScript compilation passes without errors
- [ ] CDK synth succeeds for all stacks (`cdk synth --all`)
- [ ] No HIGH or CRITICAL findings in code review (if applicable)

### 2. Environment Verification

**AWS Credentials:**
- [ ] AWS CLI configured with correct profile
- [ ] AWS region set to `eu-west-1`
- [ ] AWS account ID is `640664844884`
- [ ] Credentials have sufficient permissions for CDK deployment

**Verify credentials:**
```bash
aws sts get-caller-identity
# Expected: Account 640664844884, correct IAM role
```

**Network Access:**
- [ ] Connected to VW corporate network or VPN
- [ ] SSL/TLS certificates configured (may need `NODE_TLS_REJECT_UNAUTHORIZED=0`)
- [ ] Access to GitHub repository (for pull/push)
- [ ] Access to AWS CloudFormation, EC2, ECR, IAM services

### 3. Backup Current State

**Before making any changes, document current state:**

```bash
# Get current stack outputs
aws cloudformation describe-stacks --stack-name YouTrackStack-Local --region eu-west-1 > /tmp/youtrack-stack-before.json

# Get current instance details (if exists)
INSTANCE_ID=$(aws cloudformation describe-stacks --stack-name YouTrackStack-Local --region eu-west-1 --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' --output text)
echo "Current Instance ID: $INSTANCE_ID"

# Verify data volume exists and note volume ID
aws ec2 describe-volumes --region eu-west-1 --filters "Name=tag:Backup,Values=weekly-dlm" --query 'Volumes[*].[VolumeId,Size,State,Encrypted]' --output table
```

- [ ] Current instance ID recorded: `_________________`
- [ ] Data volume ID recorded: `_________________`
- [ ] Latest backup snapshot ID recorded: `_________________`

**Create manual snapshot if critical:**
```bash
# Get data volume ID
DATA_VOLUME_ID=$(aws ec2 describe-volumes --region eu-west-1 --filters "Name=tag:Name,Values=youtrack-data" --query 'Volumes[0].VolumeId' --output text)

# Create manual snapshot
aws ec2 create-snapshot --region eu-west-1 --volume-id $DATA_VOLUME_ID --description "Manual pre-deployment snapshot $(date +%Y-%m-%d-%H%M)"
```

- [ ] Manual snapshot created (if required)
- [ ] Snapshot ID recorded: `_________________`

## Deployment Scenarios

### Scenario A: New Deployment (Clean Install)

**Use when:** Deploying to a fresh AWS account or creating a new environment.

**Stacks to deploy:** EcrStack-Local, YouTrackStack-Local, AutomationStack-Local

**Risks:** Low (no existing resources to impact)

**Proceed to:** [New Deployment Procedure](#new-deployment-procedure)

### Scenario B: Update Deployment (Existing Infrastructure)

**Use when:** Updating existing YouTrackStack with changes (instance config, security, etc.)

**Risks:** 
- HIGH if EC2 instance replacement is required
- MEDIUM if data volume is detached/reattached
- LOW if only stack metadata or outputs change

**Check replacement risk:**
```bash
cdk diff YouTrackStack-Local 2>&1 | grep -i "replace\|requires replacement"
```

**If instance replacement is required:**
- [ ] **CRITICAL:** Instance will be terminated and recreated
- [ ] Data volume will be detached and reattached
- [ ] New instance ID will be assigned
- [ ] Downtime: ~10-15 minutes
- [ ] Manual snapshot recommended before deployment

**Proceed to:** [Update Deployment Procedure](#update-deployment-procedure)

### Scenario C: Rollback (Restore Previous Version)

**Use when:** Deployment failed or introduced issues, need to revert.

**Proceed to:** [Rollback Procedure](#rollback-procedure)

---

## New Deployment Procedure

### Step 1: Deploy ECR Stack

**Purpose:** Create ECR repository for YouTrack Docker images.

**Pre-checks:**
- [ ] No existing `EcrStack-Local` stack exists
- [ ] YouTrack image is ready to push (or will be pushed after ECR creation)

**Deploy:**
```bash
cd "C:\Users\A2I5GIV\Code\oneCloud"
cdk deploy EcrStack-Local
```

**If SSL certificate errors:**
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk deploy EcrStack-Local
```

**Post-deployment validation:**
```bash
# Verify ECR repository exists
aws ecr describe-repositories --repository-names youtrack --region eu-west-1

# Get repository URI
ECR_URI=$(aws ecr describe-repositories --repository-names youtrack --region eu-west-1 --query 'repositories[0].repositoryUri' --output text)
echo "ECR Repository URI: $ECR_URI"
```

- [ ] ECR repository created successfully
- [ ] Repository URI recorded: `_________________`
- [ ] Image scanning enabled
- [ ] Encryption enabled

**Push YouTrack image to ECR:**
```bash
# Pull image from JetBrains
docker pull jetbrains/youtrack:2026.1.12458

# Login to ECR
aws ecr get-login-password --region eu-west-1 | docker login --username AWS --password-stdin 640664844884.dkr.ecr.eu-west-1.amazonaws.com

# Tag and push
docker tag jetbrains/youtrack:2026.1.12458 640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:2026.1.12458
docker push 640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:2026.1.12458
```

- [ ] YouTrack image pushed successfully
- [ ] Image tag recorded: `_________________`
- [ ] Image scan completed (check ECR console)

### Step 2: Deploy YouTrack Stack

**Purpose:** Create EC2 instance, EBS volumes, security groups, IAM roles.

**Pre-checks:**
- [ ] ECR stack deployed successfully
- [ ] YouTrack image available in ECR
- [ ] Shared VPC is accessible
- [ ] KMS key creation is permitted (customer-managed keys)

**Review changes:**
```bash
cdk diff YouTrackStack-Local
```

- [ ] Reviewed diff output
- [ ] No unexpected resource deletions
- [ ] Instance replacement expected (if clean install)

**Deploy:**
```bash
cdk deploy YouTrackStack-Local
```

**If SSL certificate errors:**
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk deploy YouTrackStack-Local
```

**Expected duration:** 10-15 minutes

**Monitor deployment:**
- Watch CloudFormation console for stack events
- Check for `CREATE_COMPLETE` status on each resource
- If errors occur, note the resource and error message

**Post-deployment validation:**
```bash
# Get stack outputs
aws cloudformation describe-stacks --stack-name YouTrackStack-Local --region eu-west-1 --query 'Stacks[0].Outputs'

# Extract key values
INSTANCE_ID=$(aws cloudformation describe-stacks --stack-name YouTrackStack-Local --region eu-west-1 --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' --output text)
PRIVATE_IP=$(aws cloudformation describe-stacks --stack-name YouTrackStack-Local --region eu-west-1 --query 'Stacks[0].Outputs[?OutputKey==`PrivateIp`].OutputValue' --output text)
KMS_KEY_ID=$(aws cloudformation describe-stacks --stack-name YouTrackStack-Local --region eu-west-1 --query 'Stacks[0].Outputs[?OutputKey==`KmsKeyId`].OutputValue' --output text)

echo "Instance ID: $INSTANCE_ID"
echo "Private IP: $PRIVATE_IP"
echo "KMS Key ID: $KMS_KEY_ID"

# Verify instance is running
aws ec2 describe-instances --instance-ids $INSTANCE_ID --region eu-west-1 --query 'Reservations[0].Instances[0].State.Name' --output text
# Expected: running

# Verify IMDSv2 enforcement
aws ec2 describe-instances --instance-ids $INSTANCE_ID --region eu-west-1 --query 'Reservations[0].Instances[0].MetadataOptions.HttpTokens' --output text
# Expected: required

# Verify volumes are encrypted
aws ec2 describe-volumes --region eu-west-1 --filters "Name=attachment.instance-id,Values=$INSTANCE_ID" --query 'Volumes[*].[VolumeId,Encrypted,KmsKeyId,Size]' --output table
# Expected: All volumes show Encrypted=True with KMS Key ID

# Verify data volume has backup tag
aws ec2 describe-volumes --region eu-west-1 --filters "Name=tag:Name,Values=youtrack-data" --query 'Volumes[0].Tags[?Key==`Backup`].Value' --output text
# Expected: weekly-dlm
```

- [ ] Instance state: `running`
- [ ] IMDSv2 required: `required`
- [ ] Root volume encrypted: Yes, with KMS key
- [ ] Data volume encrypted: Yes, with KMS key
- [ ] Data volume tagged for backup: Yes (`Backup: weekly-dlm`)
- [ ] Instance ID: `_________________`
- [ ] Private IP: `_________________`
- [ ] KMS Key ID: `_________________`

**Verify YouTrack is running:**
```bash
# Connect via SSM and check Docker
aws ssm start-session --target $INSTANCE_ID --region eu-west-1

# Inside SSM session:
docker ps
# Expected: Container "youtrack" is running, status "Up X minutes"

docker logs youtrack | tail -20
# Expected: No critical errors, "YouTrack started" or similar message

exit
```

- [ ] Docker container running
- [ ] Container logs show successful startup
- [ ] No errors in `/var/log/youtrack-setup.log`

**Test UI access:**
```bash
# Port forward to local machine
aws ssm start-session --target $INSTANCE_ID --region eu-west-1 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8080"],"localPortNumber":["8484"]}'
```

- [ ] Port forwarding session started
- [ ] Open browser to `http://localhost:8484`
- [ ] YouTrack welcome screen loads
- [ ] Can create initial admin user
- [ ] UI is functional

### Step 3: Deploy Automation Stack

**Purpose:** Create EventBridge Scheduler and DLM lifecycle policy for automation.

**Pre-checks:**
- [ ] YouTrackStack deployed successfully
- [ ] Instance ID is available from YouTrackStack outputs

**Review changes:**
```bash
cdk diff AutomationStack-Local
```

- [ ] Reviewed diff output
- [ ] Scheduler IAM role is correct
- [ ] DLM policy targets correct tag (`Backup: weekly-dlm`)

**Deploy:**
```bash
cdk deploy AutomationStack-Local
```

**Post-deployment validation:**
```bash
# Verify scheduler exists
aws scheduler list-schedules --region eu-west-1 --query 'Schedules[?Name==`youtrack-start-schedule`]'
aws scheduler list-schedules --region eu-west-1 --query 'Schedules[?Name==`youtrack-stop-schedule`]'

# Verify DLM policy exists
aws dlm get-lifecycle-policies --region eu-west-1 --query 'Policies[?PolicyDetails.ResourceTypes[0]==`VOLUME`]'

# Check next scheduled start/stop times
aws scheduler get-schedule --name youtrack-start-schedule --region eu-west-1 --query 'ScheduleExpression'
# Expected: cron(0 7 ? * MON-FRI *)

aws scheduler get-schedule --name youtrack-stop-schedule --region eu-west-1 --query 'ScheduleExpression'
# Expected: cron(0 19 ? * MON-FRI *)
```

- [ ] Start schedule exists (7AM UTC Mon-Fri)
- [ ] Stop schedule exists (7PM UTC Mon-Fri)
- [ ] DLM policy exists (weekly Friday 6PM UTC)
- [ ] DLM policy targets data volume tag

**Test scheduler (optional, requires waiting or manual trigger):**
- [ ] Manually stop instance and wait for next start time
- [ ] Verify instance starts automatically at 7AM UTC
- [ ] Check CloudWatch Events/Scheduler logs

### Step 4: Final Validation

**Smoke test:**
- [ ] Instance is running
- [ ] Docker container is healthy
- [ ] YouTrack UI is accessible via SSM port forwarding
- [ ] Can login with admin credentials
- [ ] Can create a test project
- [ ] Data persists after container restart

**Security validation:**
- [ ] No public IP assigned to instance
- [ ] IMDSv2 required
- [ ] All volumes encrypted with customer-managed KMS
- [ ] Security group ingress limited to RFC 1918 ranges
- [ ] SSM access works, SSH fails (as expected)

**Automation validation:**
- [ ] Scheduler schedules created
- [ ] DLM policy active
- [ ] Backup tag present on data volume

**Documentation:**
- [ ] Update `CLAUDE.md` with new instance ID
- [ ] Update `docs/youtrack-access.md` if access procedures changed
- [ ] Update `docs/security-exceptions.md` if new CVEs found
- [ ] Commit documentation changes to git

---

## Update Deployment Procedure

### Step 1: Identify Changes

**Review pending changes:**
```bash
cd "C:\Users\A2I5GIV\Code\oneCloud"
git status
git diff HEAD
```

- [ ] All changes reviewed
- [ ] Changes align with intended deployment goals
- [ ] No unexpected modifications

**Check CDK diff:**
```bash
cdk diff YouTrackStack-Local
```

**Critical risk indicators:**
- `replace` or `requires replacement` for EC2 instance → **HIGH RISK**
- Changes to data volume attachment → **MEDIUM RISK**
- Changes to UserData → **LOW RISK** (takes effect on next launch)
- Changes to security group → **LOW RISK** (immediate, no downtime)
- Changes to IAM role → **LOW RISK** (immediate, no downtime)

- [ ] Diff reviewed
- [ ] Risk level assessed: LOW / MEDIUM / HIGH
- [ ] Stakeholders notified if HIGH risk

### Step 2: Prepare for Downtime (if instance replacement required)

**If diff shows instance replacement:**

**Notify users:**
- [ ] Announce maintenance window
- [ ] Estimated downtime: 10-15 minutes
- [ ] Schedule during off-hours if possible (outside Mon-Fri 7AM-7PM UTC)

**Create manual snapshot:**
```bash
DATA_VOLUME_ID=$(aws ec2 describe-volumes --region eu-west-1 --filters "Name=tag:Name,Values=youtrack-data" --query 'Volumes[0].VolumeId' --output text)

aws ec2 create-snapshot --region eu-west-1 --volume-id $DATA_VOLUME_ID --description "Pre-deployment snapshot $(date +%Y-%m-%d-%H%M)" --tag-specifications 'ResourceType=snapshot,Tags=[{Key=Name,Value=youtrack-manual-snapshot},{Key=Purpose,Value=pre-deployment-backup}]'
```

- [ ] Snapshot created
- [ ] Snapshot ID: `_________________`
- [ ] Snapshot state: `pending` → wait for `completed`

**Verify snapshot is complete:**
```bash
aws ec2 describe-snapshots --snapshot-ids snap-xxxxx --region eu-west-1 --query 'Snapshots[0].State'
# Expected: completed
```

- [ ] Snapshot completed
- [ ] Can proceed with deployment

### Step 3: Deploy Changes

**Deploy updated stack:**
```bash
cdk deploy YouTrackStack-Local
```

**If SSL certificate errors:**
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk deploy YouTrackStack-Local
```

**Monitor deployment:**
- Watch CloudFormation console
- If instance replacement:
  - Old instance will be terminated
  - New instance will be created
  - Data volume will be detached from old instance
  - Data volume will be attached to new instance
  - UserData will run on new instance

**Expected duration:**
- No instance replacement: 2-5 minutes
- Instance replacement: 10-15 minutes

### Step 4: Post-Deployment Validation

**Get new instance details:**
```bash
NEW_INSTANCE_ID=$(aws cloudformation describe-stacks --stack-name YouTrackStack-Local --region eu-west-1 --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' --output text)
NEW_PRIVATE_IP=$(aws cloudformation describe-stacks --stack-name YouTrackStack-Local --region eu-west-1 --query 'Stacks[0].Outputs[?OutputKey==`PrivateIp`].OutputValue' --output text)

echo "New Instance ID: $NEW_INSTANCE_ID"
echo "New Private IP: $NEW_PRIVATE_IP"
```

- [ ] New instance ID: `_________________`
- [ ] New private IP: `_________________`

**Verify instance state:**
```bash
aws ec2 describe-instances --instance-ids $NEW_INSTANCE_ID --region eu-west-1 --query 'Reservations[0].Instances[0].State.Name'
# Expected: running
```

- [ ] Instance state: `running`

**Verify data volume attached:**
```bash
aws ec2 describe-volumes --region eu-west-1 --filters "Name=tag:Name,Values=youtrack-data" --query 'Volumes[0].[VolumeId,State,Attachments[0].InstanceId]' --output table
```

- [ ] Data volume attached to new instance
- [ ] Volume state: `in-use`

**Check Docker container:**
```bash
aws ssm start-session --target $NEW_INSTANCE_ID --region eu-west-1

# Inside SSM:
docker ps
docker logs youtrack | tail -20
ls -la /var/youtrack-data/
exit
```

- [ ] Docker running
- [ ] Container logs show startup
- [ ] Data directory mounted and accessible

**Test YouTrack UI:**
```bash
aws ssm start-session --target $NEW_INSTANCE_ID --region eu-west-1 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8080"],"localPortNumber":["8484"]}'
```

- [ ] Port forwarding works
- [ ] UI accessible at `http://localhost:8484`
- [ ] Can login with existing credentials
- [ ] Projects and issues visible (data intact)

**Update documentation:**
```bash
# Update CLAUDE.md with new instance ID
vim CLAUDE.md
# Update Instance ID in "Current Deployment" section

git add CLAUDE.md
git commit -m "docs: update instance ID after deployment"
git push
```

- [ ] Documentation updated
- [ ] Committed to git

### Step 5: Clean Up

**Delete manual snapshot (optional, after validation):**
```bash
# Wait 24 hours to ensure stability, then delete manual snapshot
aws ec2 delete-snapshot --snapshot-id snap-xxxxx --region eu-west-1
```

- [ ] Manual snapshot deleted (after waiting period)

**Notify users deployment complete:**
- [ ] YouTrack is available
- [ ] Any new access procedures communicated

---

## Rollback Procedure

### When to Rollback

**Rollback if:**
- Deployment failed with errors
- YouTrack UI is inaccessible after deployment
- Data volume is corrupted or missing data
- Critical security misconfiguration detected
- Performance degradation or errors in application logs

**Do NOT rollback if:**
- Minor cosmetic issues (document and fix forward)
- Non-critical errors that can be fixed with patch deployment
- Changes are working as expected but different from previous behavior

### Rollback Options

#### Option 1: Rollback via CloudFormation (Preferred)

**Use when:** Deployment partially completed but failed, CloudFormation stack is in a failed state.

**Procedure:**
1. Go to AWS CloudFormation console
2. Select `YouTrackStack-Local` stack
3. Click "Stack actions" → "Roll back"
4. Confirm rollback

**Expected:** CloudFormation will revert to the last stable state.

- [ ] Rollback initiated
- [ ] Rollback completed
- [ ] Stack status: `UPDATE_ROLLBACK_COMPLETE`

**Validate rolled-back state:**
```bash
# Check instance ID (should be original)
aws cloudformation describe-stacks --stack-name YouTrackStack-Local --region eu-west-1 --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' --output text

# Verify instance running
aws ec2 describe-instances --instance-ids <original-instance-id> --region eu-west-1 --query 'Reservations[0].Instances[0].State.Name'
```

- [ ] Original instance restored
- [ ] YouTrack UI accessible
- [ ] Data intact

#### Option 2: Restore from Snapshot

**Use when:** Data is corrupted, missing, or instance is unrecoverable.

**Critical:** This is a destructive operation. Only use if Option 1 failed or data is lost.

**Procedure:**

1. **Stop instance:**
```bash
aws ec2 stop-instances --instance-ids <instance-id> --region eu-west-1
aws ec2 wait instance-stopped --instance-ids <instance-id> --region eu-west-1
```

2. **Detach data volume:**
```bash
DATA_VOLUME_ID=$(aws ec2 describe-volumes --region eu-west-1 --filters "Name=tag:Name,Values=youtrack-data" --query 'Volumes[0].VolumeId' --output text)

aws ec2 detach-volume --volume-id $DATA_VOLUME_ID --region eu-west-1
aws ec2 wait volume-available --volume-ids $DATA_VOLUME_ID --region eu-west-1
```

3. **Create new volume from snapshot:**
```bash
# Use snapshot created before deployment
SNAPSHOT_ID=snap-xxxxx  # Replace with your snapshot ID

NEW_VOLUME_ID=$(aws ec2 create-volume --region eu-west-1 --availability-zone eu-west-1a --snapshot-id $SNAPSHOT_ID --volume-type gp3 --encrypted --kms-key-id <kms-key-id> --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=youtrack-data-restored},{Key=Backup,Value=weekly-dlm}]' --query 'VolumeId' --output text)

echo "New volume created: $NEW_VOLUME_ID"

aws ec2 wait volume-available --volume-ids $NEW_VOLUME_ID --region eu-west-1
```

4. **Attach new volume to instance:**
```bash
aws ec2 attach-volume --volume-id $NEW_VOLUME_ID --instance-id <instance-id> --device /dev/sdf --region eu-west-1
```

5. **Start instance:**
```bash
aws ec2 start-instances --instance-ids <instance-id> --region eu-west-1
aws ec2 wait instance-running --instance-ids <instance-id> --region eu-west-1
```

6. **Verify data restored:**
```bash
aws ssm start-session --target <instance-id> --region eu-west-1

# Inside SSM:
ls -la /var/youtrack-data/
docker restart youtrack
docker logs youtrack | tail -20
exit
```

- [ ] New volume created from snapshot
- [ ] Volume attached to instance
- [ ] Instance started
- [ ] Data visible in /var/youtrack-data
- [ ] YouTrack started successfully

#### Option 3: Redeploy from Git

**Use when:** Need to redeploy from a known-good git commit.

**Procedure:**

1. **Identify last good commit:**
```bash
git log --oneline -10
# Find commit before deployment changes
```

2. **Checkout previous commit:**
```bash
git checkout <commit-hash>
```

3. **Rebuild and deploy:**
```bash
npm run build
cdk deploy YouTrackStack-Local
```

4. **Return to main branch after validation:**
```bash
git checkout main
```

- [ ] Previous commit identified: `_________________`
- [ ] Checked out previous commit
- [ ] Redeployed successfully
- [ ] YouTrack functional
- [ ] Returned to main branch

---

## Post-Deployment

### Documentation Updates

After successful deployment, update the following:

- [ ] `CLAUDE.md` - Update "Current Deployment" section with new instance ID, private IP
- [ ] `docs/youtrack-access.md` - Update if access procedures changed
- [ ] `docs/security-exceptions.md` - Update if new CVEs found or existing CVEs resolved
- [ ] `README.md` - Update if major architecture changes

**Commit documentation changes:**
```bash
git add CLAUDE.md docs/
git commit -m "docs: update deployment details after successful deployment"
git push origin main
```

### Security Review

- [ ] Verify all volumes encrypted
- [ ] Verify IMDSv2 enforced
- [ ] Verify no public IP assigned
- [ ] Review security group rules
- [ ] Review IAM role permissions
- [ ] Check for new security findings (AWS Security Hub, Inspector)

### Monitoring Setup

- [ ] Verify CloudWatch Logs receiving SSM session logs
- [ ] Verify instance CloudWatch metrics visible
- [ ] Set up billing alarm if not already configured
- [ ] Document any new monitoring requirements

### Knowledge Transfer

- [ ] Update runbook if procedures changed
- [ ] Notify team of new instance ID
- [ ] Document any lessons learned
- [ ] Update incident response procedures if applicable

---

## Troubleshooting

### Deployment Fails with "Resource Already Exists"

**Cause:** CloudFormation trying to create resource that already exists.

**Solution:**
1. Check if resource is part of another stack
2. Import existing resource into stack using `cdk import`
3. Or manually delete conflicting resource (if safe)

### Instance Replacement Takes Too Long

**Cause:** Volume attachment delay, UserData script slow, or EC2 service issues.

**Check:**
```bash
# Check CloudFormation events
aws cloudformation describe-stack-events --stack-name YouTrackStack-Local --region eu-west-1 --max-items 20

# Check instance status
aws ec2 describe-instance-status --instance-ids <instance-id> --region eu-west-1
```

**If stuck >20 minutes:** Cancel deployment and investigate.

### Data Volume Not Attached After Deployment

**Cause:** Volume attachment failed, wrong device name, or AZ mismatch.

**Solution:**
```bash
# Check volume state
aws ec2 describe-volumes --region eu-west-1 --filters "Name=tag:Name,Values=youtrack-data"

# Manually attach if needed
aws ec2 attach-volume --volume-id <volume-id> --instance-id <instance-id> --device /dev/sdf --region eu-west-1

# SSH via SSM and mount
aws ssm start-session --target <instance-id> --region eu-west-1
mount -a
chown -R 13001:13001 /var/youtrack-data
```

### YouTrack Container Not Starting

**Cause:** Permissions issue, volume not mounted, or image pull failure.

**Check logs:**
```bash
aws ssm start-session --target <instance-id> --region eu-west-1

# Inside SSM:
docker ps -a
docker logs youtrack
cat /var/log/youtrack-setup.log
```

**Common fixes:**
- Permissions: `chown -R 13001:13001 /var/youtrack-data`
- Volume not mounted: `mount -a`
- Image pull failed: Check ECR permissions, re-authenticate

### SSM Session Manager Not Working

**Cause:** IAM role missing, SSM agent not running, or VPC endpoint issues.

**Solution:**
```bash
# Check IAM role attached
aws ec2 describe-instances --instance-ids <instance-id> --region eu-west-1 --query 'Reservations[0].Instances[0].IamInstanceProfile'

# Check SSM agent status (via EC2 console serial output)
# Or attach AmazonSSMManagedInstanceCore policy to role
```

### KMS Key Access Denied

**Cause:** EC2 or DLM service principal not granted key access.

**Solution:**
- Check KMS key policy includes EC2 and DLM service principals
- Verify key is not pending deletion
- Check if key rotation caused issues

---

## Emergency Contacts

**YouTrack System Owner:**
- Name: José Chumbo
- VW ID: a2i5giv
- Email: jose.chumbo@volkswagen.de

**AWS Support:**
- One.Cloud Support Portal: https://one.cloud.volkswagen.com/support
- Priority: Standard (non-production system)

**Escalation:**
- If data loss occurs: Create P1 incident, contact AWS Support immediately
- If security issue detected: Notify security team, create incident ticket
- If prolonged outage: Notify development team, evaluate alternative solutions

---

## Appendix: Useful Commands

### Instance Management

```bash
# Start instance
aws ec2 start-instances --instance-ids <instance-id> --region eu-west-1

# Stop instance
aws ec2 stop-instances --instance-ids <instance-id> --region eu-west-1

# Reboot instance
aws ec2 reboot-instances --instance-ids <instance-id> --region eu-west-1

# Get instance console output
aws ec2 get-console-output --instance-ids <instance-id> --region eu-west-1
```

### Volume Management

```bash
# List all volumes
aws ec2 describe-volumes --region eu-west-1 --query 'Volumes[*].[VolumeId,Size,State,Attachments[0].InstanceId,Tags[?Key==`Name`].Value|[0]]' --output table

# Create snapshot
aws ec2 create-snapshot --volume-id <volume-id> --region eu-west-1 --description "Manual snapshot"

# List snapshots
aws ec2 describe-snapshots --owner-ids 640664844884 --region eu-west-1 --filters "Name=tag:Backup,Values=weekly-dlm"
```

### Docker Management

```bash
# Connect via SSM
aws ssm start-session --target <instance-id> --region eu-west-1

# Inside SSM:
docker ps -a
docker logs youtrack --tail 50
docker restart youtrack
docker stop youtrack
docker start youtrack
docker exec -it youtrack /bin/bash
```

### KMS Key Management

```bash
# List KMS keys
aws kms list-keys --region eu-west-1

# Describe key
aws kms describe-key --key-id <key-id> --region eu-west-1

# Get key policy
aws kms get-key-policy --key-id <key-id> --policy-name default --region eu-west-1

# Enable key rotation
aws kms enable-key-rotation --key-id <key-id> --region eu-west-1
```

### CloudFormation Stack Management

```bash
# List stacks
aws cloudformation list-stacks --region eu-west-1 --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE

# Describe stack
aws cloudformation describe-stacks --stack-name YouTrackStack-Local --region eu-west-1

# Get stack events
aws cloudformation describe-stack-events --stack-name YouTrackStack-Local --region eu-west-1 --max-items 50
```

---

## Version History

| Version | Date       | Author       | Changes                          |
|---------|------------|--------------|----------------------------------|
| 1.0     | 2026-04-27 | José Chumbo  | Initial deployment checklist     |

---

**Last Updated:** 2026-04-27
**Next Review:** 2027-04-27 (annual review)
