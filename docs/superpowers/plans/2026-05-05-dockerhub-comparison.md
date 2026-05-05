# Docker Hub Comparison Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Docker Hub latest version comparison to `--check-only` mode so users can see if ECR is behind.

**Architecture:** Add `get_dockerhub_latest()` function that queries Docker Hub API via curl+jq, then integrate the output into `show_ecr_state()` to display ECR vs Docker Hub side-by-side with upgrade suggestion.

**Tech Stack:** Bash, curl, jq, Docker Hub public API

---

### Task 1: Add `get_dockerhub_latest()` function

**Files:**
- Modify: `scripts/update-youtrack-image.sh` (insert after `show_ecr_state()`, before `get_instance_id()`)

**Step 1: Add the function after `show_ecr_state()`**

Insert after line 58 (the closing brace of `show_ecr_state`), before line 60 (`get_instance_id`):

```bash
# Returns latest tag info from Docker Hub in format: tag|digest|date
# Returns exit code 1 if jq missing or Docker Hub unreachable
get_dockerhub_latest() {
  # Check if jq is available
  if ! command -v jq >/dev/null 2>&1; then
    echo "  ⚠️  jq not found. Install with: yum install jq"
    return 1
  fi

  # Query Docker Hub API
  local response
  response=$(curl -s --max-time 10 \
    "https://hub.docker.com/v2/repositories/jetbrains/youtrack/tags?page_size=100&ordering=-last_updated" \
    2>/dev/null)

  if [[ -z "$response" ]]; then
    echo "  ⚠️  Could not reach Docker Hub (check: internet access, Zscaler proxy)"
    return 1
  fi

  # Parse response with jq
  local latest_tag latest_digest latest_date
  latest_tag=$(echo "$response" | jq -r '.results[0].name' 2>/dev/null)
  latest_digest=$(echo "$response" | jq -r '.results[0].digest' 2>/dev/null)
  latest_date=$(echo "$response" | jq -r '.results[0].last_updated' 2>/dev/null)

  if [[ -z "$latest_tag" || "$latest_tag" == "null" ]]; then
    echo "  ⚠️  Could not parse Docker Hub response"
    return 1
  fi

  echo "$latest_tag|$latest_digest|$latest_date"
}
```

**Step 2: Verify script still parses**

```bash
bash -n scripts/update-youtrack-image.sh
```
Expected: No output (syntax OK)

**Step 3: Commit**

```bash
git add scripts/update-youtrack-image.sh
git commit -m "feat: add get_dockerhub_latest function for API query"
```

---

### Task 2: Integrate Docker Hub display into `show_ecr_state()`

**Files:**
- Modify: `scripts/update-youtrack-image.sh:52-58` (end of `show_ecr_state` function)

**Step 1: Add Docker Hub section before the function's closing**

Find the end of `show_ecr_state()` (around line 56-58):
```bash
  echo "────────────────────────────────────────────────────────────"
  echo ""
}
```

Replace with:
```bash
  echo "────────────────────────────────────────────────────────────"

  # Docker Hub comparison
  echo ""
  echo "🐋 Docker Hub: jetbrains/youtrack"
  echo "────────────────────────────────────────────────────────────"

  local dockerhub_info
  dockerhub_info=$(get_dockerhub_latest)
  if [[ $? -eq 0 ]]; then
    IFS='|' read -r dh_tag dh_digest dh_date <<< "$dockerhub_info"
    echo "  Latest version: ${dh_tag}"
    echo "  Published: ${dh_date}"
    echo "  Digest: ${dh_digest}"
    
    echo ""
    echo "💡 To upgrade to Docker Hub latest:"
    echo "   ./scripts/update-youtrack-image.sh ${dh_tag}"
  fi
  echo "────────────────────────────────────────────────────────────"

  echo ""
}
```

**Step 2: Test with jq installed and Docker Hub reachable**

```bash
./scripts/update-youtrack-image.sh --check-only
```
Expected output:
```
📦 ECR: 640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack
────────────────────────────────────────────────────────────
  TAG                       PUSHED AT                    DIGEST (short)
  2026.1.12458              2026-04-15T09:53:56          ed55f3fdcc21

  latest digest: sha256:...
────────────────────────────────────────────────────────────

🐋 Docker Hub: jetbrains/youtrack
────────────────────────────────────────────────────────────
  Latest version: 2026.1.XXXXX
  Published: 2026-XX-XXTXX:XX:XXZ
  Digest: sha256:...

💡 To upgrade to Docker Hub latest:
   ./scripts/update-youtrack-image.sh 2026.1.XXXXX
────────────────────────────────────────────────────────────
```

**Step 3: Test jq missing scenario**

```bash
# Temporarily hide jq (if installed)
PATH_BACKUP=$PATH
export PATH=$(echo $PATH | sed 's|:/usr/bin||')
./scripts/update-youtrack-image.sh --check-only
export PATH=$PATH_BACKUP
```
Expected: ECR section + "⚠️  jq not found" message in Docker Hub section

**Step 4: Test Docker Hub unreachable (optional)**

Edit `get_dockerhub_latest()` temporarily to use a bad URL:
```bash
# Change curl line to:
response=$(curl -s --max-time 10 \
  "https://invalid.example.com/v2/repositories/jetbrains/youtrack/tags" \
  2>/dev/null)
```

Run:
```bash
./scripts/update-youtrack-image.sh --check-only
```
Expected: ECR section + "⚠️  Could not reach Docker Hub" message

Revert the URL change before committing.

**Step 5: Commit**

```bash
git add scripts/update-youtrack-image.sh
git commit -m "feat: integrate Docker Hub comparison into show_ecr_state"
```

---

### Task 3: Update CLAUDE.md documentation

**Files:**
- Modify: `CLAUDE.md` (YouTrack Image Management section, around line 76-95)

**Step 1: Add jq dependency note**

Find the "YouTrack Image Management" section in CLAUDE.md and add a note about the new dependency:

After the existing usage example, add:
```markdown
**Dependencies for `--check-only` with Docker Hub comparison:**
- `jq` — JSON parser for Docker Hub API response
  - Install: `yum install jq` (RHEL/Amazon Linux) or `brew install jq` (macOS)
  - Graceful fallback: if jq is missing, script shows ECR state only
```

**Step 2: Verify markdown renders correctly**

```bash
# Check for markdown syntax errors
cat CLAUDE.md | grep -A 5 "Dependencies for"
```
Expected: clean markdown with proper list formatting

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document jq dependency for Docker Hub comparison"
```

---

### Task 4: Final integration test

**Files:** none (verification only)

**Step 1: Run full --check-only with jq available**

```bash
./scripts/update-youtrack-image.sh --check-only
```
Expected: Both ECR and Docker Hub sections displayed with upgrade suggestion

**Step 2: Verify full update flow still works**

```bash
./scripts/update-youtrack-image.sh 2026.1.12458
```
Expected: 
- ECR table (with Docker Hub section)
- Instance ID resolved
- Either "already in ECR" message or pull/push sequence
- (Will likely prompt to restart since version unchanged)

Enter `N` at the prompt to avoid restarting.

**Step 3: Document completion**

No commit needed — this is a verification-only step. If all tests pass, the feature is complete.
