# YouTrack Image Update Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `scripts/update-youtrack-image.sh` with ECR version checking, `--check-only` mode, and automated SSM-based container restart; update `lib/youtrack-stack.ts` to use `:latest` ECR tag.

**Architecture:** Single bash script with modular functions — ECR inspection, Docker pull/push, SSM restart. The CDK UserData change is committed first and is independent. The `retag_as_latest_in_ecr` path uses ECR's `batch-get-image` + `put-image` API directly (no Docker pull needed). All other paths require Docker running locally. Instance ID is resolved at runtime from CloudFormation outputs.

**Tech Stack:** Bash, AWS CLI (`ecr`, `cloudformation`, `ssm`, `ec2`), Docker, Python 3 (for JSON parsing in ECR display)

---

### Task 1: Update CDK UserData to use `:latest` tag

**Files:**
- Modify: `lib/youtrack-stack.ts:157`

- [ ] **Step 1: Edit the `docker run` line in UserData**

In `lib/youtrack-stack.ts`, find line 157. Change:
```
  '  640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:2026.1.12458',
```
to:
```
  '  640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:latest',
```

- [ ] **Step 2: Verify the change**

```bash
grep -n "youtrack:" lib/youtrack-stack.ts
```
Expected output contains:
```
157:  '  640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:latest',
```

- [ ] **Step 3: Confirm CDK synthesizes without errors**

```bash
cdk synth 2>&1 | grep -E "youtrack:|Error"
```
Expected: one line containing `youtrack:latest`, no lines containing `Error`.

- [ ] **Step 4: Commit**

```bash
git add lib/youtrack-stack.ts
git commit -m "feat: use :latest ECR tag in UserData for version-agnostic deployments"
```

---

### Task 2: Script skeleton — constants and argument parsing

**Files:**
- Modify: `scripts/update-youtrack-image.sh` (full rewrite)

- [ ] **Step 1: Replace entire script content**

```bash
#!/bin/bash
set -euo pipefail

ECR_REGISTRY="640664844884.dkr.ecr.eu-west-1.amazonaws.com"
ECR_REPO="youtrack"
REGION="eu-west-1"
STACK_NAME="YouTrackStack"
CONTAINER_NAME="youtrack"

usage() {
  echo "Usage:"
  echo "  $0 --check-only     Show current ECR state, make no changes"
  echo "  $0 <VERSION>        Update YouTrack to VERSION (e.g. 2026.1.13000)"
  exit 1
}

if [[ $# -eq 0 ]]; then
  usage
fi

CHECK_ONLY=false
VERSION=""

if [[ "$1" == "--check-only" ]]; then
  CHECK_ONLY=true
elif [[ "$1" == --* ]]; then
  echo "❌ Unknown flag: $1"
  usage
else
  VERSION="$1"
fi

echo "✅ Parsed: CHECK_ONLY=${CHECK_ONLY} VERSION=${VERSION}"
```

- [ ] **Step 2: Verify argument parsing**

```bash
bash scripts/update-youtrack-image.sh --check-only
```
Expected:
```
✅ Parsed: CHECK_ONLY=true VERSION=
```

```bash
bash scripts/update-youtrack-image.sh 2026.1.13000
```
Expected:
```
✅ Parsed: CHECK_ONLY=false VERSION=2026.1.13000
```

```bash
bash scripts/update-youtrack-image.sh 2>&1; echo "exit: $?"
```
Expected: usage printed, `exit: 1`.

- [ ] **Step 3: Commit**

```bash
git add scripts/update-youtrack-image.sh
git commit -m "feat: script skeleton with argument parsing"
```

---

### Task 3: `show_ecr_state` function

**Files:**
- Modify: `scripts/update-youtrack-image.sh`

- [ ] **Step 1: Add the function after the constants block, before argument parsing**

Insert after the `CONTAINER_NAME` line and before `usage()`:

```bash
# Print all version-tagged images in ECR, marking which one 'latest' points to.
# Requires: aws CLI, python3
show_ecr_state() {
  echo ""
  echo "📦 ECR: ${ECR_REGISTRY}/${ECR_REPO}"
  echo "────────────────────────────────────────────────────────────"

  local latest_digest=""
  latest_digest=$(aws ecr describe-images \
    --repository-name "${ECR_REPO}" \
    --region "${REGION}" \
    --image-ids imageTag=latest \
    --query 'imageDetails[0].imageDigest' \
    --output text 2>/dev/null || true)
  [[ "$latest_digest" == "None" ]] && latest_digest=""

  # python3 -c reads the script from the argument, leaving stdin free for the pipe
  local py_script='
import json, sys
latest_digest = sys.argv[1] if len(sys.argv) > 1 else ""
data = json.load(sys.stdin)
data.sort(key=lambda x: x[1], reverse=True)
print("  {:<25} {:<28} {}".format("TAG", "PUSHED AT", "DIGEST (short)"))
for tags, pushed, digest in data:
    version_tags = [t for t in tags if t != "latest"]
    if not version_tags:
        continue
    tag = ", ".join(version_tags)
    short = digest[7:19]
    marker = "  <- latest" if digest == latest_digest else ""
    print("  {:<25} {:<28} {}{}".format(tag, pushed, short, marker))
'

  aws ecr describe-images \
    --repository-name "${ECR_REPO}" \
    --region "${REGION}" \
    --query 'imageDetails[?imageTags != `null`].[imageTags, imagePushedAt, imageDigest]' \
    --output json | python3 -c "$py_script" "${latest_digest}"

  if [[ -n "$latest_digest" ]]; then
    echo ""
    echo "  latest digest: ${latest_digest}"
  fi
  echo "────────────────────────────────────────────────────────────"
  echo ""
}
```

- [ ] **Step 2: Call it from the main block (replace the debug echo at the bottom)**

Replace `echo "✅ Parsed: ..."` with:

```bash
show_ecr_state

if [[ "$CHECK_ONLY" == "true" ]]; then
  exit 0
fi

echo "▶ Version: ${VERSION}"
```

- [ ] **Step 3: Test `--check-only` against real ECR**

```bash
bash scripts/update-youtrack-image.sh --check-only
```
Expected: table showing `2026.1.12458` (or whatever is in ECR) with `<- latest` marker if tagged, full digest shown at bottom. Exits cleanly.

- [ ] **Step 4: Commit**

```bash
git add scripts/update-youtrack-image.sh
git commit -m "feat: add ECR state display function"
```

---

### Task 4: Instance lookup, state check, and SSM restart

**Files:**
- Modify: `scripts/update-youtrack-image.sh`

- [ ] **Step 1: Add three functions after `show_ecr_state`**

```bash
# Returns instance ID from CloudFormation stack outputs.
get_instance_id() {
  aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}" \
    --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
    --output text
}

# Exits with instructions if the instance is not in 'running' state.
check_instance_running() {
  local instance_id="$1"
  local state
  state=$(aws ec2 describe-instances \
    --instance-ids "${instance_id}" \
    --region "${REGION}" \
    --query 'Reservations[0].Instances[0].State.Name' \
    --output text)

  if [[ "$state" != "running" ]]; then
    echo "❌ Instance ${instance_id} is not running (state: ${state})."
    echo ""
    echo "   Start it first:"
    echo "   aws ec2 start-instances --instance-ids ${instance_id} --region ${REGION}"
    echo ""
    echo "   Then re-run this script once it's running."
    exit 1
  fi
}

# Sends docker restart commands to EC2 via SSM and polls until complete.
restart_container_on_ec2() {
  local instance_id="$1"
  echo "🔄 Sending restart command to ${instance_id} via SSM..."

  local command_id
  command_id=$(aws ssm send-command \
    --instance-ids "${instance_id}" \
    --document-name "AWS-RunShellScript" \
    --region "${REGION}" \
    --parameters 'commands=[
      "aws ecr get-login-password --region eu-west-1 | docker login --username AWS --password-stdin 640664844884.dkr.ecr.eu-west-1.amazonaws.com",
      "docker pull 640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:latest",
      "docker stop youtrack && docker rm youtrack",
      "docker run -d --name youtrack --restart=always -p 8080:8080 -v /var/youtrack-data/data:/opt/youtrack/data -v /var/youtrack-data/conf:/opt/youtrack/conf -v /var/youtrack-data/logs:/opt/youtrack/logs -v /var/youtrack-data/backups:/opt/youtrack/backups 640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:latest",
      "docker ps --filter name=youtrack --format \"Running: {{.Image}} ({{.Status}})\""
    ]' \
    --query 'Command.CommandId' \
    --output text)

  echo "  Command ID: ${command_id}"
  echo "  Polling..."

  local status="Pending"
  local attempts=0
  while [[ "$status" == "InProgress" || "$status" == "Pending" ]]; do
    sleep 5
    status=$(aws ssm get-command-invocation \
      --command-id "${command_id}" \
      --instance-id "${instance_id}" \
      --region "${REGION}" \
      --query 'Status' \
      --output text 2>/dev/null || echo "Pending")
    attempts=$((attempts + 1))
    if [[ $attempts -gt 60 ]]; then
      echo "❌ Timed out waiting for SSM command (5 min limit)."
      exit 1
    fi
  done

  local stdout stderr
  stdout=$(aws ssm get-command-invocation \
    --command-id "${command_id}" \
    --instance-id "${instance_id}" \
    --region "${REGION}" \
    --query 'StandardOutputContent' \
    --output text)
  stderr=$(aws ssm get-command-invocation \
    --command-id "${command_id}" \
    --instance-id "${instance_id}" \
    --region "${REGION}" \
    --query 'StandardErrorContent' \
    --output text)

  echo ""
  echo "  Remote stdout:"
  echo "$stdout" | sed 's/^/    /'
  if [[ -n "$stderr" && "$stderr" != "None" ]]; then
    echo "  Remote stderr:"
    echo "$stderr" | sed 's/^/    /'
  fi

  if [[ "$status" == "Success" ]]; then
    echo ""
    echo "✅ Container restarted on ${instance_id}"
  else
    echo ""
    echo "❌ SSM command failed (status: ${status})"
    exit 1
  fi
}
```

- [ ] **Step 2: Add instance resolution after the `check-only` exit in the main block**

Replace `echo "▶ Version: ${VERSION}"` with:

```bash
INSTANCE_ID=$(get_instance_id)
if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == "None" ]]; then
  echo "❌ Could not resolve instance ID from stack '${STACK_NAME}'. Is the stack deployed?"
  exit 1
fi
echo "🖥️  Instance: ${INSTANCE_ID}"
check_instance_running "${INSTANCE_ID}"
echo "▶ Version to deploy: ${VERSION}"
```

- [ ] **Step 3: Verify instance lookup works**

```bash
bash scripts/update-youtrack-image.sh 2026.1.12458 2>&1 | head -15
```
Expected: ECR table, then `🖥️  Instance: i-XXXXXXXXXX`, then either `check_instance_running` passes (if instance is running) or exits with start instructions. The script will not restart anything yet because we haven't wired in the update logic.

- [ ] **Step 4: Commit**

```bash
git add scripts/update-youtrack-image.sh
git commit -m "feat: add instance state check and SSM restart function"
```

---

### Task 5: ECR version comparison and image push functions

**Files:**
- Modify: `scripts/update-youtrack-image.sh`

- [ ] **Step 1: Add four functions after `restart_container_on_ec2`**

```bash
# Returns the ECR image digest for a given tag, or empty string if tag not found.
get_ecr_digest() {
  local tag="$1"
  local digest
  digest=$(aws ecr describe-images \
    --repository-name "${ECR_REPO}" \
    --region "${REGION}" \
    --image-ids imageTag="${tag}" \
    --query 'imageDetails[0].imageDigest' \
    --output text 2>/dev/null || true)
  [[ "$digest" == "None" || -z "$digest" ]] && echo "" || echo "$digest"
}

# Verifies Docker daemon is running locally.
check_docker() {
  if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Start Docker Desktop and retry."
    exit 1
  fi
}

# Pulls VERSION from Docker Hub, pushes to ECR with version tag and as 'latest'.
pull_and_push_to_ecr() {
  local version="$1"
  check_docker

  echo "📥 Pulling jetbrains/youtrack:${version} from Docker Hub..."
  if ! docker pull "jetbrains/youtrack:${version}"; then
    echo "❌ Docker pull failed."
    echo "   If on the corporate network, try from a machine not behind Zscaler,"
    echo "   or configure a proxy bypass for registry-1.docker.io."
    exit 1
  fi

  echo "🔑 Logging in to ECR..."
  aws ecr get-login-password --region "${REGION}" | \
    docker login --username AWS --password-stdin "${ECR_REGISTRY}"

  echo "🏷️  Tagging for ECR..."
  docker tag "jetbrains/youtrack:${version}" "${ECR_REGISTRY}/${ECR_REPO}:${version}"
  docker tag "jetbrains/youtrack:${version}" "${ECR_REGISTRY}/${ECR_REPO}:latest"

  echo "📤 Pushing ${ECR_REGISTRY}/${ECR_REPO}:${version}..."
  docker push "${ECR_REGISTRY}/${ECR_REPO}:${version}"

  echo "📤 Pushing ${ECR_REGISTRY}/${ECR_REPO}:latest..."
  docker push "${ECR_REGISTRY}/${ECR_REPO}:latest"

  echo "✅ Pushed ${version} and updated latest."
}

# Retags an existing ECR image as 'latest' using the ECR API (no Docker pull needed).
retag_as_latest_in_ecr() {
  local version="$1"
  echo "🏷️  Retagging ${version} as latest in ECR (via ECR API, no Docker pull needed)..."

  local manifest
  manifest=$(aws ecr batch-get-image \
    --repository-name "${ECR_REPO}" \
    --region "${REGION}" \
    --image-ids imageTag="${version}" \
    --query 'images[0].imageManifest' \
    --output text)

  aws ecr put-image \
    --repository-name "${ECR_REPO}" \
    --region "${REGION}" \
    --image-tag latest \
    --image-manifest "${manifest}" > /dev/null

  echo "✅ Retagged ${version} as latest."
}
```

- [ ] **Step 2: Add the main update decision logic after the instance check block**

Replace `echo "▶ Version to deploy: ${VERSION}"` with:

```bash
echo ""
echo "🔍 Checking if ${VERSION} already exists in ECR..."
VERSION_DIGEST=$(get_ecr_digest "${VERSION}")
LATEST_DIGEST=$(get_ecr_digest "latest")

if [[ -n "$VERSION_DIGEST" && "$VERSION_DIGEST" == "$LATEST_DIGEST" ]]; then
  echo "ℹ️  ${VERSION} is already in ECR and is already tagged as latest."
  echo ""
  read -r -p "   Restart container on EC2 anyway? (y/N) " reply
  if [[ ! "$reply" =~ ^[Yy]$ ]]; then
    echo "Nothing to do. Exiting."
    exit 0
  fi
elif [[ -n "$VERSION_DIGEST" && "$VERSION_DIGEST" != "$LATEST_DIGEST" ]]; then
  echo "ℹ️  ${VERSION} is in ECR but not tagged as latest. Retagging via ECR API..."
  retag_as_latest_in_ecr "${VERSION}"
else
  echo "  ${VERSION} not found in ECR. Pulling from Docker Hub..."
  pull_and_push_to_ecr "${VERSION}"
fi

echo ""
restart_container_on_ec2 "${INSTANCE_ID}"

echo ""
show_ecr_state
echo "🎉 Done. YouTrack is now running ${VERSION}."
```

- [ ] **Step 3: Smoke test — request the version already deployed**

With instance running:
```bash
bash scripts/update-youtrack-image.sh 2026.1.12458
```
Expected: ECR state shown, instance found and running, then either:
- `already in ECR and is already tagged as latest` → prompt appears → enter `N` → exits cleanly
- Or `already in ECR but not tagged as latest` → retags → SSM restart runs

Either path means the version comparison logic works. Enter `N` at the prompt if it appears.

- [ ] **Step 4: Commit**

```bash
git add scripts/update-youtrack-image.sh
git commit -m "feat: add ECR version comparison, Docker pull/push, and main update flow"
```

---

### Task 6: Integration test — deploy patched version to resolve CVE-2026-2332

This task is performed when you have the patched YouTrack version number (check [JetBrains YouTrack release notes](https://www.jetbrains.com/youtrack/download/) for a version that updates Jetty beyond the vulnerable range).

**Files:** none — verification only

- [ ] **Step 1: Check current ECR state and confirm CVE image digest**

```bash
bash scripts/update-youtrack-image.sh --check-only
```
Verify the `latest digest` matches `sha256:ed55f3fdcc215a794994b10afc33504dd14e901de8210c01f1bbcc992ed5d456` (the CVE-affected image).

- [ ] **Step 2: Run the full update**

```bash
bash scripts/update-youtrack-image.sh <PATCHED_VERSION>
```
Replace `<PATCHED_VERSION>` with the actual version (e.g. `2026.1.13000`).

Expected sequence:
1. ECR table printed
2. Instance ID resolved, confirmed running
3. `<PATCHED_VERSION> not found in ECR. Pulling from Docker Hub...`
4. Docker pull + push with version tag + push as `latest`
5. SSM command sent, polling shown
6. Remote stdout: `docker ps` showing new image running
7. Final ECR table: new version shown with `<- latest`, old version still present
8. `🎉 Done. YouTrack is now running <PATCHED_VERSION>.`

- [ ] **Step 3: Confirm the old CVE digest is no longer `latest`**

```bash
bash scripts/update-youtrack-image.sh --check-only
```
Expected: `latest digest` is now a different value from `sha256:ed55f3fdcc215a794994b10afc33504dd14e901de8210c01f1bbcc992ed5d456`.

- [ ] **Step 4: Update `docs/security-exceptions.md` if needed**

If CVE-2026-2332 was documented there, update or remove the entry now that it's resolved.

- [ ] **Step 5: Final commit**

```bash
git add docs/security-exceptions.md  # only if modified
git commit -m "fix: resolve CVE-2026-2332 by updating YouTrack to <PATCHED_VERSION>"
```
