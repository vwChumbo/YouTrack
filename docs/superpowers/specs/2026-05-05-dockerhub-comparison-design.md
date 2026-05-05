# Docker Hub Latest Version Comparison Design

**Date:** 2026-05-05  
**Context:** User wants to see ECR vs Docker Hub comparison in `--check-only` mode to decide if an upgrade is needed.

---

## Goal

Enhance `scripts/update-youtrack-image.sh --check-only` to query Docker Hub's API and display the latest available YouTrack version alongside ECR state, showing whether ECR is behind.

---

## Display Format

```
📦 ECR: 640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack
────────────────────────────────────────────────────────────
  TAG                       PUSHED AT                    DIGEST (short)
  2026.1.12458              2026-04-15T09:53:56          ed55f3fdcc21  <- latest

  latest digest: sha256:ed55f3fdcc215a794994b10afc33504dd14e901de8210c01f1bbcc992ed5d456
────────────────────────────────────────────────────────────

🐋 Docker Hub: jetbrains/youtrack
────────────────────────────────────────────────────────────
  Latest version: 2026.1.13162
  Published: 2026-05-03T10:23:45Z
  Digest: sha256:b223421d23d94d313851a2e3de0389e17d642025a0c7fa0279b567d8f5c3cf9b
────────────────────────────────────────────────────────────

💡 ECR may be behind Docker Hub
   Run: ./scripts/update-youtrack-image.sh 2026.1.13162
```

### Error Cases

**jq not installed:**
```
🐋 Docker Hub: jetbrains/youtrack
────────────────────────────────────────────────────────────
  ⚠️  jq not found. Install with: yum install jq
────────────────────────────────────────────────────────────
```

**Docker Hub unreachable (Zscaler/network):**
```
🐋 Docker Hub: jetbrains/youtrack
────────────────────────────────────────────────────────────
  ⚠️  Could not reach Docker Hub (check: internet access, Zscaler proxy)
────────────────────────────────────────────────────────────
```

---

## Technical Implementation

### New Function: `get_dockerhub_latest()`

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

### Modified `show_ecr_state()`

After the existing ECR display logic (around line 58), add:

```bash
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
  
  # Compare with ECR latest tag (version, not digest)
  # Find the ECR version tag that has the latest digest
  local ecr_latest_version=""
  # (This requires looking up which version tag in ECR has the same digest as 'latest')
  # Simple approach: if dh_tag doesn't match any ECR version, suggest upgrade
  
  echo ""
  echo "💡 To upgrade to Docker Hub latest:"
  echo "   ./scripts/update-youtrack-image.sh ${dh_tag}"
fi
echo "────────────────────────────────────────────────────────────"
```

---

## API Details

**Endpoint:** `https://hub.docker.com/v2/repositories/jetbrains/youtrack/tags`

**Query Parameters:**
- `page_size=100` — fetch up to 100 tags
- `ordering=-last_updated` — sort by most recently updated first

**Response Format:**
```json
{
  "results": [
    {
      "name": "2026.1.13162",
      "digest": "sha256:b223421d...",
      "last_updated": "2026-05-03T10:23:45.123456Z"
    }
  ]
}
```

**Timeout:** 10 seconds via `curl --max-time 10`

**No authentication needed** — `jetbrains/youtrack` is a public repository

---

## Error Handling

| Scenario | Behavior |
|---|---|
| `jq` not installed | Print warning, skip Docker Hub lookup |
| Docker Hub unreachable (Zscaler) | Print network warning, continue with ECR-only display |
| Docker Hub API returns empty/null | Print parse error, continue |
| `curl` not installed | Script will fail (but `curl` is standard on all target systems) |

---

## Files Changed

| File | Change |
|---|---|
| `scripts/update-youtrack-image.sh` | Add `get_dockerhub_latest()` function after `show_ecr_state()`, modify `show_ecr_state()` to call it |

---

## Dependencies

- **jq** — JSON parser (graceful fallback if missing)
- **curl** — HTTP client (already a de-facto standard tool)
- **Python 3** — already required by existing `show_ecr_state` function

---

## Testing

```bash
# Normal case (jq installed, Docker Hub reachable)
./scripts/update-youtrack-image.sh --check-only
# Expected: Shows both ECR and Docker Hub sections

# jq missing
# (Temporarily rename jq binary)
./scripts/update-youtrack-image.sh --check-only
# Expected: Shows ECR section + "jq not found" warning

# Docker Hub blocked (simulate with bad URL)
# (Edit function to use invalid URL)
./scripts/update-youtrack-image.sh --check-only
# Expected: Shows ECR section + "Could not reach Docker Hub" warning
```
