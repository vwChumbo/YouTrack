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
    pushed = pushed[:19]
    version_tags = [t for t in tags if t != "latest"]
    if not version_tags:
        continue
    tag = ", ".join(version_tags)
    short = digest.split(":", 1)[1][:12] if ":" in digest else digest[:12]
    marker = "  <- latest" if digest == latest_digest else ""
    print("  {:<25} {:<28} {}{}".format(tag, pushed, short, marker))
'

  if ! aws ecr describe-images \
    --repository-name "${ECR_REPO}" \
    --region "${REGION}" \
    --query 'imageDetails[?imageTags != `null`].[imageTags, imagePushedAt, imageDigest]' \
    --output json | python3 -c "$py_script" "${latest_digest}"; then
    echo "  ⚠️  Could not list images (check: aws CLI output, python3 installed?)"
  fi

  if [[ -n "$latest_digest" ]]; then
    echo ""
    echo "  latest digest: ${latest_digest}"
  fi
  echo "────────────────────────────────────────────────────────────"

  # Docker Hub comparison
  echo ""
  echo "🐋 Docker Hub: jetbrains/youtrack"
  echo "────────────────────────────────────────────────────────────"

  local dockerhub_info exit_code
  set +e  # Temporarily disable exit on error for optional Docker Hub check
  dockerhub_info=$(get_dockerhub_latest)
  exit_code=$?
  set -e  # Re-enable exit on error

  if [[ $exit_code -eq 0 ]]; then
    IFS='|' read -r dh_tag dh_digest dh_date <<< "$dockerhub_info"
    echo "  Latest version: ${dh_tag}"
    echo "  Published: ${dh_date}"
    echo "  Digest: ${dh_digest}"

    echo ""
    echo "💡 To upgrade to Docker Hub latest:"
    echo "   ./scripts/update-youtrack-image.sh ${dh_tag}"
  else
    # Display error message from get_dockerhub_latest
    echo "$dockerhub_info"
  fi
  echo "────────────────────────────────────────────────────────────"

  echo ""
}

# Returns latest tag info from Docker Hub in format: tag|digest|date
# Returns exit code 1 if jq missing or Docker Hub unreachable
get_dockerhub_latest() {
  # Check if jq is available
  if ! command -v jq >/dev/null 2>&1; then
    echo "  ⚠️  jq not found. Install with: yum install jq"
    return 1
  fi

  # Query Docker Hub API (fetch more results to find latest production tag)
  local response
  response=$(curl -s --max-time 10 \
    "https://hub.docker.com/v2/repositories/jetbrains/youtrack/tags?page_size=100" \
    2>/dev/null)

  if [[ -z "$response" ]]; then
    echo "  ⚠️  Could not reach Docker Hub (check: internet access, Zscaler proxy)"
    return 1
  fi

  # Parse response with jq - filter for production tags (YYYY.M.BUILD format) and sort by name
  # Single jq call returns pipe-delimited: name|digest|date
  local latest_info
  latest_info=$(echo "$response" | jq -r '[.results[] | select(.name | test("^20[0-9]{2}\\.[0-9]+\\.[0-9]+$"))] | sort_by(.name) | last | "\(.name)|\(.digest)|\(.last_updated)"' 2>/dev/null)

  local latest_tag latest_digest latest_date
  IFS='|' read -r latest_tag latest_digest latest_date <<< "$latest_info"

  if [[ -z "$latest_tag" || "$latest_tag" == "null" ]]; then
    echo "  ⚠️  Could not parse Docker Hub response"
    return 1
  fi

  echo "$latest_tag|$latest_digest|$latest_date"
}

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
    --parameters "commands=[
      \"aws ecr get-login-password --region ${REGION} | docker login --username AWS --password-stdin ${ECR_REGISTRY}\",
      \"docker pull ${ECR_REGISTRY}/${ECR_REPO}:latest\",
      \"docker stop ${CONTAINER_NAME} 2>/dev/null || true; docker rm ${CONTAINER_NAME} 2>/dev/null || true\",
      \"docker run -d --name ${CONTAINER_NAME} --restart=always --user 13001:13001 -p 8080:8080 -v /var/youtrack-data/data:/opt/youtrack/data -v /var/youtrack-data/conf:/opt/youtrack/conf -v /var/youtrack-data/logs:/opt/youtrack/logs -v /var/youtrack-data/backups:/opt/youtrack/backups ${ECR_REGISTRY}/${ECR_REPO}:latest\",
      \"docker ps --filter name=${CONTAINER_NAME} --no-trunc\"
    ]" \
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
  if ! aws ecr get-login-password --region "${REGION}" | \
      docker login --username AWS --password-stdin "${ECR_REGISTRY}"; then
    echo "❌ ECR login failed. Check your AWS credentials and region."
    exit 1
  fi

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

  if [[ -z "$manifest" || "$manifest" == "None" ]]; then
    echo "❌ Could not retrieve manifest for ${version} from ECR. Aborting retag."
    exit 1
  fi

  aws ecr put-image \
    --repository-name "${ECR_REPO}" \
    --region "${REGION}" \
    --image-tag latest \
    --image-manifest "${manifest}" > /dev/null

  echo "✅ Retagged ${version} as latest."
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

INSTANCE_ID=$(get_instance_id)
if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == "None" ]]; then
  echo "❌ Could not resolve instance ID from stack '${STACK_NAME}'. Is the stack deployed?"
  exit 1
fi
echo "🖥️  Instance: ${INSTANCE_ID}"
check_instance_running "${INSTANCE_ID}"
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
