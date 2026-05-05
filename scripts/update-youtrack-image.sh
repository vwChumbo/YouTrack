#!/bin/bash
set -euo pipefail

ECR_REGISTRY="640664844884.dkr.ecr.eu-west-1.amazonaws.com"
ECR_REPO="youtrack"
REGION="eu-west-1"
STACK_NAME="YouTrackStack"
CONTAINER_NAME="youtrack"

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

show_ecr_state

if [[ "$CHECK_ONLY" == "true" ]]; then
  exit 0
fi

echo "▶ Version: ${VERSION}"
