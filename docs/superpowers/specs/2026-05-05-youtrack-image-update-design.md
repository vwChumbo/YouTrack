# YouTrack Image Update Script Design

**Date:** 2026-05-05  
**Context:** CVE-2026-2332 (Jetty HTTP request smuggling) found in ECR image `sha256:ed55f3fdcc215a794994b10afc33504dd14e901de8210c01f1bbcc992ed5d456`. Resolve-by: 2026-06-27.

---

## Goal

Enhance `scripts/update-youtrack-image.sh` to:
1. Check what version is currently in ECR before doing any work (avoid unnecessary uploads)
2. Push a new version to ECR and retag `latest`
3. Remotely restart the container on EC2 via SSM — no manual steps required

Also update `lib/youtrack-stack.ts` to reference `:latest` instead of a hardcoded version tag, so future updates are script-only.

---

## Script Interface

```
# Read-only: show ECR state
./scripts/update-youtrack-image.sh --check-only

# Full update
./scripts/update-youtrack-image.sh <VERSION>
# e.g. ./scripts/update-youtrack-image.sh 2026.1.13000
```

### Check-only mode

Queries ECR and prints:
- All version tags with their pushed dates
- Which version `latest` currently points to (resolved via image digest comparison)
- The digest of `latest` (for matching against Inspector/SecurityHub CVE findings)

Exits 0, makes no changes.

### Full update mode

1. Print current ECR state (same as `--check-only`) for confirmation
2. Check if the requested version already exists in ECR by tag
   - If it does **and** its digest matches `latest`: inform user nothing to do, offer to restart container anyway
   - If it does **and** its digest does not match `latest`: skip pull/push, retag `latest` to this version, then restart
   - If it does **not** exist: pull from Docker Hub → push with version tag → push as `latest` → restart
3. Use `aws ssm send-command` to restart the container on EC2
4. Poll `ssm get-command-invocation` until complete, print stdout/stderr

---

## SSM Restart Sequence

Remote commands sent to the EC2 instance:

```bash
aws ecr get-login-password --region eu-west-1 \
  | docker login --username AWS --password-stdin \
    640664844884.dkr.ecr.eu-west-1.amazonaws.com

docker pull 640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:latest

docker stop youtrack && docker rm youtrack

docker run -d --name youtrack --restart=always \
  -p 8080:8080 \
  -v /var/youtrack-data/data:/opt/youtrack/data \
  -v /var/youtrack-data/conf:/opt/youtrack/conf \
  -v /var/youtrack-data/logs:/opt/youtrack/logs \
  -v /var/youtrack-data/backups:/opt/youtrack/backups \
  640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:latest
```

The instance ID is resolved dynamically from CloudFormation stack outputs (`YouTrackStack`) — not hardcoded — so it stays correct if the instance is replaced by a CDK redeploy.

---

## CDK Change

Update `lib/youtrack-stack.ts` line 157 (the `docker run` command in UserData):

```
# Before
640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:2026.1.12458

# After
640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:latest
```

This means new EC2 instances (launched by CDK) will always pull whatever is tagged `latest` in ECR at boot time. No CDK change is needed for future version upgrades.

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Docker not running locally | Exit early with message before any AWS calls |
| EC2 instance is stopped | Check instance state before SSM; print manual start command and exit |
| Version already in ECR and already `latest` | Inform user, offer to restart container or exit |
| Docker Hub pull fails (e.g. Zscaler) | Exit before any ECR writes; ECR state unchanged |
| SSM command fails on EC2 | Print remote stderr; exit non-zero |

---

## Constants (in script)

```bash
ECR_REGISTRY="640664844884.dkr.ecr.eu-west-1.amazonaws.com"
ECR_REPO="youtrack"
REGION="eu-west-1"
STACK_NAME="YouTrackStack"
CONTAINER_NAME="youtrack"
```

Instance ID resolved at runtime:
```bash
aws cloudformation describe-stacks \
  --stack-name YouTrackStack \
  --region eu-west-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
  --output text
```

---

## Files Changed

| File | Change |
|---|---|
| `scripts/update-youtrack-image.sh` | Full rewrite with `--check-only`, version comparison, SSM restart |
| `lib/youtrack-stack.ts` | Line 157: hardcoded version → `:latest` |
