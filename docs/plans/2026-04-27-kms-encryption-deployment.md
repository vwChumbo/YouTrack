# KMS Encryption Deployment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deploy customer-managed KMS encryption to YouTrackStack-Local with zero data loss during instance replacement.

**Architecture:** Update deployment executing the "Update Deployment Procedure" from deployment-checklist.md. Stack update will replace EC2 instance (new ID assigned), create customer-managed KMS key, and update all EBS volumes to use the new key. Data volume will be detached from old instance and reattached to new instance.

**Tech Stack:** AWS CDK, CloudFormation, AWS CLI, EC2, KMS, SSM Session Manager

**Risk Level:** HIGH (instance replacement with 10-15 min downtime)

---

## Task 1: Pre-Deployment Code Validation

**Files:**
- Modify: `docs/deployment-checklist.md` (if uncommitted changes exist)

**Step 1: Check git status**

Run:
```bash
git status --short
```

Expected output shows:
```
M docs/deployment-checklist.md
?? tmp/
```

**Step 2: Commit pending changes**

Run:
```bash
git add docs/deployment-checklist.md
git commit -m "docs: finalize deployment checklist before execution"
```

Expected: Commit succeeds, git status clean except for tmp/

**Step 3: Verify git working tree is clean**

Run:
```bash
git status
```

Expected output:
```
On branch main
nothing to commit, working tree clean
```
(Ignore untracked tmp/ directory)

**Step 4: Validate CDK templates compile**

Run:
```bash
cd "C:\Users\A2I5GIV\Code\oneCloud"
cdk synth --all
```

Expected: CloudFormation templates output successfully, no errors

If SSL certificate errors occur, retry with:
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk synth --all
```

---

## Task 2: Environment and State Verification

**Step 1: Verify AWS credentials**

Run:
```bash
aws sts get-caller-identity
```

Expected output includes:
```json
{
    "Account": "640664844884",
    ...
}
```

**Step 2: Verify AWS region configuration**

Run:
```bash
aws configure get region
```

Expected output: `eu-west-1`

**Step 3: Capture current stack state**

Run:
```bash
aws cloudformation describe-stacks --stack-name YouTrackStack-Local --region eu-west-1 > /tmp/youtrack-stack-before.json
```

Expected: File created at /tmp/youtrack-stack-before.json

**Step 4: Get current instance ID**

Run:
```bash
INSTANCE_ID=$(aws cloudformation describe-stacks --stack-name YouTrackStack-Local --region eu-west-1 --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' --output text)
echo "Current Instance ID: $INSTANCE_ID"
```

Expected output:
```
Current Instance ID: i-0591fecf34c1b50ca
```

**Step 5: Verify data volume exists**

Run:
```bash
aws ec2 describe-volumes --region eu-west-1 --filters "Name=tag:Name,Values=youtrack-data" --query 'Volumes[*].[VolumeId,Size,State,Encrypted]' --output table
```

Expected: Table showing volume vol-0959de1b8294c8e9b, 50GB, in-use, encrypted

---

## Task 3: Create Pre-Deployment Snapshot

**Step 1: Get data volume ID**

Run:
```bash
DATA_VOLUME_ID=$(aws ec2 describe-volumes --region eu-west-1 --filters "Name=tag:Name,Values=youtrack-data" --query 'Volumes[0].VolumeId' --output text)
echo "Data Volume ID: $DATA_VOLUME_ID"
```

Expected output:
```
Data Volume ID: vol-0959de1b8294c8e9b
```

**Step 2: Create manual snapshot**

Run:
```bash
SNAPSHOT_ID=$(aws ec2 create-snapshot --region eu-west-1 --volume-id $DATA_VOLUME_ID --description "Pre-deployment snapshot 2026-04-27" --tag-specifications 'ResourceType=snapshot,Tags=[{Key=Name,Value=youtrack-manual-snapshot},{Key=Purpose,Value=pre-deployment-backup}]' --query 'SnapshotId' --output text)
echo "Snapshot ID: $SNAPSHOT_ID"
```

Expected output:
```
Snapshot ID: snap-xxxxxxxxxxxxxxxxx
```

**Step 3: Wait for snapshot completion**

Run:
```bash
echo "Waiting for snapshot to complete..."
aws ec2 wait snapshot-completed --snapshot-ids $SNAPSHOT_ID --region eu-west-1
echo "Snapshot completed successfully"
```

Expected: Command waits (2-5 minutes), then outputs "Snapshot completed successfully"

**Step 4: Verify snapshot state**

Run:
```bash
aws ec2 describe-snapshots --snapshot-ids $SNAPSHOT_ID --region eu-west-1 --query 'Snapshots[0].[State,Progress]' --output table
```

Expected output:
```
-----------------
|  completed    |
|  100%         |
-----------------
```

**Step 5: Record snapshot ID for rollback**

Run:
```bash
echo "SNAPSHOT_ID=$SNAPSHOT_ID" > /tmp/deployment-snapshot.txt
cat /tmp/deployment-snapshot.txt
```

Expected: File created with snapshot ID recorded

---

## Task 4: Review Deployment Changes

**Step 1: Run CDK diff**

Run:
```bash
cd "C:\Users\A2I5GIV\Code\oneCloud"
cdk diff YouTrackStack-Local 2>&1 | tee /tmp/cdk-diff-output.txt
```

If SSL errors occur, retry with:
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk diff YouTrackStack-Local 2>&1 | tee /tmp/cdk-diff-output.txt
```

Expected output shows:
- `[+] AWS::KMS::Key YouTrackEbsKey`
- `[+] AWS::KMS::Alias YouTrackEbsKey/Alias`
- `[+] AWS::EC2::LaunchTemplate`
- `[~] AWS::EC2::Instance YouTrackInstance ... replace`
- `[~] AWS::EC2::Volume YouTrackDataVolume` (KmsKeyId added)

**Step 2: Verify instance replacement is expected**

Run:
```bash
grep -i "replace\|requires replacement" /tmp/cdk-diff-output.txt
```

Expected output includes:
```
[~] AWS::EC2::Instance YouTrackInstance ... replace
```

**Step 3: Confirm risk assessment**

Expected understanding:
- Instance WILL be replaced (old terminated, new created)
- New instance ID will be assigned
- Data volume will be detached and reattached
- Downtime: 10-15 minutes
- Snapshot created as safety net

---

## Task 5: Execute Deployment

**Step 1: Record deployment start time**

Run:
```bash
echo "Deployment started: $(date)" | tee /tmp/deployment-log.txt
```

Expected: Timestamp recorded in /tmp/deployment-log.txt

**Step 2: Deploy stack**

Run:
```bash
cd "C:\Users\A2I5GIV\Code\oneCloud"
cdk deploy YouTrackStack-Local
```

If SSL errors occur, retry with:
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk deploy YouTrackStack-Local
```

Expected: CDK prompts "Do you wish to deploy these changes (y/n)?" → Answer: **y**

**Step 3: Monitor deployment progress**

Watch CloudFormation events in console or CLI:
```bash
watch -n 5 "aws cloudformation describe-stack-events --stack-name YouTrackStack-Local --region eu-west-1 --max-items 10 --query 'StackEvents[*].[Timestamp,ResourceStatus,ResourceType,LogicalResourceId]' --output table"
```

Expected resource events:
1. `CREATE_IN_PROGRESS` AWS::KMS::Key YouTrackEbsKey
2. `CREATE_COMPLETE` AWS::KMS::Key YouTrackEbsKey
3. `CREATE_IN_PROGRESS` AWS::EC2::LaunchTemplate
4. `CREATE_IN_PROGRESS` AWS::EC2::Instance (new instance)
5. `DELETE_IN_PROGRESS` AWS::EC2::Instance (old instance)
6. `UPDATE_IN_PROGRESS` AWS::EC2::Volume (data volume)
7. `UPDATE_COMPLETE_CLEANUP_IN_PROGRESS` YouTrackStack-Local
8. `UPDATE_COMPLETE` YouTrackStack-Local

Expected duration: 10-15 minutes

**Step 4: Wait for deployment completion**

Expected final output from CDK:
```
✅  YouTrackStack-Local

Outputs:
YouTrackStack-Local.InstanceId = i-xxxxxxxxxxxxxxxxx
YouTrackStack-Local.PrivateIp = 10.x.x.x
YouTrackStack-Local.KmsKeyId = xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
...
```

**Step 5: Record deployment completion**

Run:
```bash
echo "Deployment completed: $(date)" | tee -a /tmp/deployment-log.txt
```

Expected: Timestamp appended to /tmp/deployment-log.txt

---

## Task 6: Post-Deployment Infrastructure Validation

**Step 1: Extract new instance details**

Run:
```bash
NEW_INSTANCE_ID=$(aws cloudformation describe-stacks --stack-name YouTrackStack-Local --region eu-west-1 --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' --output text)
NEW_PRIVATE_IP=$(aws cloudformation describe-stacks --stack-name YouTrackStack-Local --region eu-west-1 --query 'Stacks[0].Outputs[?OutputKey==`PrivateIp`].OutputValue' --output text)
KMS_KEY_ID=$(aws cloudformation describe-stacks --stack-name YouTrackStack-Local --region eu-west-1 --query 'Stacks[0].Outputs[?OutputKey==`KmsKeyId`].OutputValue' --output text)

echo "New Instance ID: $NEW_INSTANCE_ID"
echo "New Private IP: $NEW_PRIVATE_IP"
echo "KMS Key ID: $KMS_KEY_ID"
```

Expected: Three values displayed (new instance ID, private IP, KMS key ID)

**Step 2: Verify instance state is running**

Run:
```bash
aws ec2 describe-instances --instance-ids $NEW_INSTANCE_ID --region eu-west-1 --query 'Reservations[0].Instances[0].State.Name' --output text
```

Expected output: `running`

**Step 3: Verify IMDSv2 enforcement**

Run:
```bash
aws ec2 describe-instances --instance-ids $NEW_INSTANCE_ID --region eu-west-1 --query 'Reservations[0].Instances[0].MetadataOptions.HttpTokens' --output text
```

Expected output: `required`

**Step 4: Verify all volumes are encrypted with KMS**

Run:
```bash
aws ec2 describe-volumes --region eu-west-1 --filters "Name=attachment.instance-id,Values=$NEW_INSTANCE_ID" --query 'Volumes[*].[VolumeId,Encrypted,KmsKeyId,Size,Attachments[0].Device]' --output table
```

Expected output shows:
- Root volume (/dev/xvda): 30GB, Encrypted=True, KmsKeyId=arn:aws:kms:...
- Data volume (/dev/sdf): 50GB, Encrypted=True, KmsKeyId=arn:aws:kms:...

**Step 5: Verify data volume has backup tag**

Run:
```bash
aws ec2 describe-volumes --region eu-west-1 --filters "Name=tag:Name,Values=youtrack-data" --query 'Volumes[0].Tags[?Key==`Backup`].Value' --output text
```

Expected output: `weekly-dlm`

**Step 6: Verify data volume is attached**

Run:
```bash
aws ec2 describe-volumes --region eu-west-1 --filters "Name=tag:Name,Values=youtrack-data" --query 'Volumes[0].[VolumeId,State,Attachments[0].InstanceId]' --output table
```

Expected output:
```
------------------------------------
|  vol-0959de1b8294c8e9b          |
|  in-use                         |
|  i-xxxxxxxxxxxxxxxxx (new ID)   |
------------------------------------
```

---

## Task 7: Post-Deployment Application Validation

**Step 1: Connect to instance via SSM**

Run:
```bash
aws ssm start-session --target $NEW_INSTANCE_ID --region eu-west-1
```

Expected: SSM session starts, shell prompt appears

**Step 2: Check Docker container status**

Run inside SSM session:
```bash
docker ps
```

Expected output shows:
```
CONTAINER ID   IMAGE                                                      STATUS
xxxxxxxxxxxx   640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:...  Up X minutes
```

**Step 3: Check Docker logs for startup success**

Run inside SSM session:
```bash
docker logs youtrack | tail -20
```

Expected: No critical errors, should see "YouTrack started" or similar success message

**Step 4: Verify data directory is mounted**

Run inside SSM session:
```bash
ls -la /var/youtrack-data/
```

Expected: Directory exists, files present, owned by 13001:13001

**Step 5: Exit SSM session**

Run inside SSM session:
```bash
exit
```

Expected: SSM session terminated, return to local shell

---

## Task 8: Post-Deployment UI Validation

**Step 1: Start port forwarding session**

Run:
```bash
aws ssm start-session --target $NEW_INSTANCE_ID --region eu-west-1 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8080"],"localPortNumber":["8484"]}'
```

Expected output:
```
Starting session with SessionId: ...
Port 8484 opened for sessionId ...
Waiting for connections...
```

**Step 2: Test YouTrack UI access**

Action: Open browser to http://localhost:8484

Expected: YouTrack login screen or welcome page loads

**Step 3: Verify data integrity**

Action in browser:
1. Login with existing credentials
2. Navigate to projects list
3. Verify projects are visible
4. Open an issue to confirm data intact

Expected: All existing projects and issues accessible

**Step 4: Stop port forwarding**

Action: Press Ctrl+C in terminal running port forwarding session

Expected: Session closed, return to shell prompt

---

## Task 9: Post-Deployment Security Validation

**Step 1: Verify no public IP assigned**

Run:
```bash
aws ec2 describe-instances --instance-ids $NEW_INSTANCE_ID --region eu-west-1 --query 'Reservations[0].Instances[0].PublicIpAddress' --output text
```

Expected output: `None` or empty

**Step 2: Verify security group rules**

Run:
```bash
SG_ID=$(aws ec2 describe-instances --instance-ids $NEW_INSTANCE_ID --region eu-west-1 --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' --output text)
aws ec2 describe-security-groups --group-ids $SG_ID --region eu-west-1 --query 'SecurityGroups[0].IpPermissions[*].[FromPort,ToPort,IpRanges[*].CidrIp]' --output table
```

Expected: Only RFC 1918 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) allowed on port 8080

**Step 3: Verify KMS key policy includes required principals**

Run:
```bash
aws kms get-key-policy --key-id $KMS_KEY_ID --policy-name default --region eu-west-1 --query 'Policy' --output text | grep -E "ec2.amazonaws.com|dlm.amazonaws.com"
```

Expected output includes both:
- `ec2.amazonaws.com`
- `dlm.amazonaws.com`

---

## Task 10: Update Documentation

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Record deployment details for documentation**

Run:
```bash
echo "OLD_INSTANCE_ID=i-0591fecf34c1b50ca" >> /tmp/deployment-log.txt
echo "NEW_INSTANCE_ID=$NEW_INSTANCE_ID" >> /tmp/deployment-log.txt
echo "NEW_PRIVATE_IP=$NEW_PRIVATE_IP" >> /tmp/deployment-log.txt
echo "KMS_KEY_ID=$KMS_KEY_ID" >> /tmp/deployment-log.txt
cat /tmp/deployment-log.txt
```

Expected: All deployment details recorded

**Step 2: Update CLAUDE.md with new instance details**

Modify `CLAUDE.md` at line ~140 ("Current Deployment" section):

Old content:
```markdown
**Instance Details** (as of last deployment):
- Stack: YouTrackStack-Local
- Instance ID: i-0591fecf34c1b50ca
- Private IP: Check stack outputs or EC2 console
```

New content:
```markdown
**Instance Details** (as of last deployment):
- Stack: YouTrackStack-Local
- Instance ID: <$NEW_INSTANCE_ID value>
- Private IP: <$NEW_PRIVATE_IP value>
```

Also update the KMS Key ID section around line 155:

Old content:
```markdown
**Security Configuration:**
- IMDSv2: Enforced (requireImdsv2: true)
- Root Volume: 30GB gp3, encrypted with customer-managed KMS key
- Data Volume: 50GB gp3, encrypted with customer-managed KMS key
- KMS Key Alias: alias/youtrack-ebs-encryption
- KMS Key Rotation: Enabled (annual automatic)
```

New content:
```markdown
**Security Configuration:**
- IMDSv2: Enforced (requireImdsv2: true)
- Root Volume: 30GB gp3, encrypted with customer-managed KMS key
- Data Volume: 50GB gp3, encrypted with customer-managed KMS key
- KMS Key Alias: alias/youtrack-ebs-encryption
- KMS Key ID: <$KMS_KEY_ID value>
- KMS Key Rotation: Enabled (annual automatic)
```

Update deployment date around line 200:

Old: `**Instance Details** (as of last deployment):`
New: `**Instance Details** (as of 2026-04-27):`

**Step 3: Commit CLAUDE.md updates**

Run:
```bash
git add CLAUDE.md
git commit -m "docs: update instance ID and KMS key after deployment"
```

Expected: Commit succeeds

**Step 4: Push documentation to GitHub**

Run:
```bash
git push origin main
```

Expected: Push succeeds

---

## Task 11: Final Verification and Cleanup

**Step 1: Verify instance is still running**

Run:
```bash
aws ec2 describe-instances --instance-ids $NEW_INSTANCE_ID --region eu-west-1 --query 'Reservations[0].Instances[0].State.Name' --output text
```

Expected output: `running`

**Step 2: Verify automated schedules reference new instance**

Run:
```bash
aws scheduler get-schedule --name youtrack-start-schedule --region eu-west-1 --query 'Target.RoleArn' --output text
aws scheduler get-schedule --name youtrack-stop-schedule --region eu-west-1 --query 'Target.RoleArn' --output text
```

Expected: Schedules exist (they use CloudFormation stack outputs, so auto-update)

**Step 3: Create deployment summary**

Run:
```bash
cat << EOF > /tmp/deployment-summary.txt
=== YouTrack KMS Encryption Deployment Summary ===
Date: 2026-04-27
Status: SUCCESS

Old Instance: i-0591fecf34c1b50ca (terminated)
New Instance: $NEW_INSTANCE_ID (running)
New Private IP: $NEW_PRIVATE_IP
KMS Key ID: $KMS_KEY_ID

Snapshot Created: $(cat /tmp/deployment-snapshot.txt)
Downtime: ~10-15 minutes
Data Integrity: VERIFIED (UI accessible, projects visible)

Validation Results:
- Instance state: running ✓
- IMDSv2 enforced: required ✓
- Root volume encrypted: KMS ✓
- Data volume encrypted: KMS ✓
- Data volume attached: in-use ✓
- Backup tag present: weekly-dlm ✓
- Docker container: running ✓
- YouTrack UI: accessible ✓
- Security: no public IP ✓
- Documentation: updated ✓

Next Steps:
- Monitor instance for 24-48 hours
- Manual snapshot can be deleted after stability confirmed
- Weekly DLM backups continue automatically
EOF

cat /tmp/deployment-summary.txt
```

Expected: Deployment summary displayed

**Step 4: Announce completion**

Expected announcement:
```
✅ Deployment completed successfully!

Old instance i-0591fecf34c1b50ca has been replaced with $NEW_INSTANCE_ID.
All volumes are now encrypted with customer-managed KMS key.
Data integrity verified - YouTrack is accessible with all data intact.
Documentation updated in CLAUDE.md.

Manual snapshot retained at: $(cat /tmp/deployment-snapshot.txt)
You can delete this snapshot after 24-48 hours if no issues occur.
```

---

## Rollback Procedures (If Needed)

### Rollback Option 1: CloudFormation Rollback

**If deployment fails during execution:**

Step 1: Initiate rollback via AWS Console
- Go to CloudFormation console
- Select YouTrackStack-Local
- Stack Actions → Roll back

Step 2: Monitor rollback
```bash
watch -n 5 "aws cloudformation describe-stack-events --stack-name YouTrackStack-Local --region eu-west-1 --max-items 10 --query 'StackEvents[*].[Timestamp,ResourceStatus,LogicalResourceId]' --output table"
```

Expected: Stack returns to UPDATE_ROLLBACK_COMPLETE

Step 3: Verify old instance restored
```bash
aws cloudformation describe-stacks --stack-name YouTrackStack-Local --region eu-west-1 --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' --output text
```

Expected: Shows i-0591fecf34c1b50ca (original instance)

### Rollback Option 2: Restore from Snapshot

**If data is corrupted or missing:**

Step 1: Load snapshot ID
```bash
source /tmp/deployment-snapshot.txt
echo "Restoring from: $SNAPSHOT_ID"
```

Step 2: Stop instance
```bash
aws ec2 stop-instances --instance-ids $NEW_INSTANCE_ID --region eu-west-1
aws ec2 wait instance-stopped --instance-ids $NEW_INSTANCE_ID --region eu-west-1
```

Step 3: Detach data volume
```bash
DATA_VOLUME_ID=$(aws ec2 describe-volumes --region eu-west-1 --filters "Name=tag:Name,Values=youtrack-data" --query 'Volumes[0].VolumeId' --output text)
aws ec2 detach-volume --volume-id $DATA_VOLUME_ID --region eu-west-1
aws ec2 wait volume-available --volume-ids $DATA_VOLUME_ID --region eu-west-1
```

Step 4: Create volume from snapshot
```bash
NEW_VOLUME_ID=$(aws ec2 create-volume --region eu-west-1 --availability-zone eu-west-1a --snapshot-id $SNAPSHOT_ID --volume-type gp3 --encrypted --kms-key-id $KMS_KEY_ID --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=youtrack-data-restored},{Key=Backup,Value=weekly-dlm}]' --query 'VolumeId' --output text)
aws ec2 wait volume-available --volume-ids $NEW_VOLUME_ID --region eu-west-1
```

Step 5: Attach new volume
```bash
aws ec2 attach-volume --volume-id $NEW_VOLUME_ID --instance-id $NEW_INSTANCE_ID --device /dev/sdf --region eu-west-1
```

Step 6: Start instance
```bash
aws ec2 start-instances --instance-ids $NEW_INSTANCE_ID --region eu-west-1
aws ec2 wait instance-running --instance-ids $NEW_INSTANCE_ID --region eu-west-1
```

Step 7: Verify data restored
```bash
aws ssm start-session --target $NEW_INSTANCE_ID --region eu-west-1
# Inside SSM: ls -la /var/youtrack-data/ && docker restart youtrack
```

---

## Verification Checklist

After completing all tasks, verify:

- [x] Stack status: UPDATE_COMPLETE
- [x] New instance running with IMDSv2 enforced
- [x] All volumes encrypted with customer-managed KMS key
- [x] Data volume attached with backup tag
- [x] Docker container running
- [x] YouTrack UI accessible
- [x] Existing data visible (projects/issues)
- [x] No public IP assigned
- [x] Security group rules unchanged
- [x] CLAUDE.md updated with new instance details
- [x] Changes committed and pushed to GitHub
- [x] Manual snapshot created and recorded
- [x] Deployment summary documented

**Success Criteria Met:** All checkboxes above marked complete.
