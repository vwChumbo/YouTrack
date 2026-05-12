# YouTrack CloudWatch Logging — Full Restoration Design

**Date:** 2026-05-12
**Status:** Approved
**Scope:** YouTrackStack only (AutomationStack unchanged)

---

## Problem

The 4 CloudWatch log groups and associated IAM permissions were implemented in the `claude/heuristic-rhodes-b22f8a` worktree branch and deployed to AWS, but were never merged into `main`. When `YouTrackStack` was deployed from `main` today, CDK reverted the IAM policy (dropping the container log group permission). The running container — created 5 days ago with `--log-driver=awslogs` — could not create a CloudWatch log stream on restart and exited with code 128.

The 4 log groups still exist in AWS (all have `removalPolicy: RETAIN`) but are orphaned from CDK management. The `main` branch CDK code must be updated to own them again.

---

## Solution

Restore all 4 log groups, IAM permissions, CloudWatch Agent UserData, Docker awslogs driver, and EventBridge state change rule into `main`'s `YouTrackStack`. Deploy, then apply a one-time SSM fix to the running instance to recreate the container with the correct flags and install CW Agent.

`AutomationStack` is **not changed** — the direct `ec2:StartInstances` approach (06:00 + 06:30 UTC) deployed today stays as-is.

---

## Log Groups

All 4 groups encrypted with the existing customer-managed KMS key (`alias/app-prod-key`, `KeyPurpose.APP_PROD`). All have `removalPolicy: RETAIN`.

| Log group | CDK construct ID | Source | Retention |
|---|---|---|---|
| `/aws/ec2/youtrack/cloud-init` | `CloudInitLogs` | CW Agent → `/var/log/cloud-init-output.log` | 30 days |
| `/aws/ec2/youtrack/system` | `SystemLogs` | CW Agent → `/var/log/messages` | 90 days |
| `/aws/ec2/youtrack/container` | `ContainerLogs` | Docker `--log-driver=awslogs` | 90 days |
| `/aws/ec2/youtrack/state-changes` | `StateChangeLogs` | EventBridge rule | 180 days |

These groups already exist in AWS — CDK will adopt them (same logical IDs as the worktree deployment, so no recreation).

---

## IAM Changes (`YouTrackInstanceRole`)

**New statement — CW Agent + Docker awslogs:**
```typescript
instanceRole.addToPolicy(new iam.PolicyStatement({
  actions: [
    'logs:CreateLogStream',
    'logs:PutLogEvents',
    'logs:DescribeLogStreams',
  ],
  resources: [
    cloudInitLogGroup.logGroupArn,
    systemLogGroup.logGroupArn,
    containerLogGroup.logGroupArn,
    stateChangeLogGroup.logGroupArn,
  ],
}));
```

**New statement — CW Agent metrics:**
```typescript
instanceRole.addToPolicy(new iam.PolicyStatement({
  actions: ['cloudwatch:PutMetricData'],
  resources: ['*'], // CW Agent requirement — cannot be scoped
}));
```

**Existing unchanged:**
- ECR pull permissions on `*`
- `logs:CreateLogStream` + `logs:PutLogEvents` on `/aws/ssm/YouTrack`
- KMS encrypt/decrypt on app key (already covers all new encrypted log groups)

---

## UserData Additions

Added **after** the existing Docker install + container start block.

### CloudWatch Agent install and config

```bash
# Install CloudWatch Agent
yum install -y amazon-cloudwatch-agent

# Write agent config
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'EOF'
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/cloud-init-output.log",
            "log_group_name": "/aws/ec2/youtrack/cloud-init",
            "log_stream_name": "{instance_id}"
          },
          {
            "file_path": "/var/log/messages",
            "log_group_name": "/aws/ec2/youtrack/system",
            "log_stream_name": "{instance_id}"
          }
        ]
      }
    }
  }
}
EOF

# Enable and start agent
systemctl enable amazon-cloudwatch-agent
systemctl start amazon-cloudwatch-agent
```

### Docker run command update

The `docker run` command gains 4 new flags:
```bash
docker run -d --name youtrack --restart=always \
  --log-driver=awslogs \
  --log-opt awslogs-region=eu-west-1 \
  --log-opt awslogs-group=/aws/ec2/youtrack/container \
  --log-opt awslogs-stream=youtrack \
  -p 8080:8080 \
  -v /var/youtrack-data/data:/opt/youtrack/data \
  -v /var/youtrack-data/conf:/opt/youtrack/conf \
  -v /var/youtrack-data/logs:/opt/youtrack/logs \
  -v /var/youtrack-data/backups:/opt/youtrack/backups \
  640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:latest
```

---

## EventBridge State Change Rule

Uses `CfnRule` + `CfnResourcePolicy` directly — **not** `aws-events-targets.CloudWatchLogGroup` which creates a Lambda-backed custom resource blocked by the One.Cloud Lambda SCP.

**Event pattern:** `EC2 Instance State-change Notification` filtered to instance ID `i-07f47d6f9108e5bb6`.

**Target:** `/aws/ec2/youtrack/state-changes` log group.

**Resource policy on log group:** grants `events.amazonaws.com` `logs:CreateLogStream` + `logs:PutLogEvents` (EventBridge writes via resource policy, not via instance role).

No changes to the instance IAM role needed for this rule.

---

## Deployment Sequence

### Step 1 — `cdk deploy YouTrackStack`

- CDK adopts the 4 existing log groups
- IAM policy updated (restores container log group permission)
- EventBridge rule created
- UserData updated (staged for next instance replacement — does **not** reboot current instance)

The running container is still broken after this step, but IAM is restored.

### Step 2 — One-time SSM fix (~3 min YouTrack downtime)

Recreate container with awslogs flags + install CW Agent on the running instance:

```bash
# Recreate container with awslogs flags
docker stop youtrack
docker rm youtrack
aws ecr get-login-password --region eu-west-1 | \
  docker login --username AWS --password-stdin \
  640664844884.dkr.ecr.eu-west-1.amazonaws.com
docker run -d --name youtrack --restart=always \
  --log-driver=awslogs \
  --log-opt awslogs-region=eu-west-1 \
  --log-opt awslogs-group=/aws/ec2/youtrack/container \
  --log-opt awslogs-stream=youtrack \
  -p 8080:8080 \
  -v /var/youtrack-data/data:/opt/youtrack/data \
  -v /var/youtrack-data/conf:/opt/youtrack/conf \
  -v /var/youtrack-data/logs:/opt/youtrack/logs \
  -v /var/youtrack-data/backups:/opt/youtrack/backups \
  640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:latest

# Install and start CW Agent
yum install -y amazon-cloudwatch-agent
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'EOF'
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/cloud-init-output.log",
            "log_group_name": "/aws/ec2/youtrack/cloud-init",
            "log_stream_name": "{instance_id}"
          },
          {
            "file_path": "/var/log/messages",
            "log_group_name": "/aws/ec2/youtrack/system",
            "log_stream_name": "{instance_id}"
          }
        ]
      }
    }
  }
}
EOF
systemctl enable amazon-cloudwatch-agent
systemctl start amazon-cloudwatch-agent
```

### Step 3 — Verify

- CloudWatch Logs `/aws/ec2/youtrack/container` → YouTrack startup output visible
- CloudWatch Logs `/aws/ec2/youtrack/system` → OS messages flowing in
- SSM port-forward → YouTrack UI loads at `http://localhost:8484`

---

## Future Deploys

If `YouTrackStack` UserData ever changes again, CDK replaces the EC2 instance. The new instance runs UserData fresh — Docker creates the container with the correct awslogs flags from the start. CW Agent is installed and configured. **No manual SSM step needed on future deploys.**

---

## One.Cloud Compliance

- All log groups encrypted with customer-managed KMS key (`alias/app-prod-key`) ✅
- All log groups have explicit retention policies ✅
- EventBridge → CloudWatch Logs uses `CfnRule` + `CfnResourcePolicy` (no Lambda) ✅
- No new public IPs, no SSH, no marketplace resources ✅
- No AWS-managed KMS keys ✅

---

## Files Changed

| File | Change |
|---|---|
| `lib/youtrack-stack.ts` | Add 4 log groups, IAM additions, UserData additions (CW Agent + awslogs), EventBridge state change rule |
| `lib/automation-stack.ts` | **No change** |
| `bin/youtrack-app.ts` | **No change** |
