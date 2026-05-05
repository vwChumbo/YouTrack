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
