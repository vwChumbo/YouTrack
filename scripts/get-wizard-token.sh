#!/bin/bash
set -euo pipefail

REGION="eu-west-1"
STACK_NAME="YouTrackStack"
CONTAINER_NAME="youtrack"
TOKEN_PATH="/opt/youtrack/conf/internal/services/configurationWizard/wizard_token.txt"

# Get instance ID from CloudFormation stack
get_instance_id() {
  aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}" \
    --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
    --output text
}

echo "🔍 Resolving instance ID from stack ${STACK_NAME}..."
INSTANCE_ID=$(get_instance_id)

if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == "None" ]]; then
  echo "❌ Could not resolve instance ID from stack '${STACK_NAME}'"
  exit 1
fi

echo "🖥️  Instance: ${INSTANCE_ID}"
echo ""
echo "📝 Fetching wizard token..."

# Send SSM command to read token from container
COMMAND_ID=$(aws ssm send-command \
  --instance-ids "${INSTANCE_ID}" \
  --document-name "AWS-RunShellScript" \
  --region "${REGION}" \
  --parameters "commands=[\"docker exec ${CONTAINER_NAME} cat ${TOKEN_PATH}\"]" \
  --query 'Command.CommandId' \
  --output text)

echo "  Command ID: ${COMMAND_ID}"
echo "  Waiting for result..."

# Poll for completion
STATUS="Pending"
ATTEMPTS=0
while [[ "$STATUS" == "InProgress" || "$STATUS" == "Pending" ]]; do
  sleep 2
  STATUS=$(aws ssm get-command-invocation \
    --command-id "${COMMAND_ID}" \
    --instance-id "${INSTANCE_ID}" \
    --region "${REGION}" \
    --query 'Status' \
    --output text 2>/dev/null || echo "Pending")
  ATTEMPTS=$((ATTEMPTS + 1))
  if [[ $ATTEMPTS -gt 30 ]]; then
    echo "❌ Timed out waiting for SSM command (60 seconds)"
    exit 1
  fi
done

if [[ "$STATUS" != "Success" ]]; then
  echo "❌ SSM command failed (status: ${STATUS})"
  STDERR=$(aws ssm get-command-invocation \
    --command-id "${COMMAND_ID}" \
    --instance-id "${INSTANCE_ID}" \
    --region "${REGION}" \
    --query 'StandardErrorContent' \
    --output text)
  echo "Error: $STDERR"
  exit 1
fi

# Get the token from stdout
TOKEN=$(aws ssm get-command-invocation \
  --command-id "${COMMAND_ID}" \
  --instance-id "${INSTANCE_ID}" \
  --region "${REGION}" \
  --query 'StandardOutputContent' \
  --output text | tr -d '\n\r')

echo ""
echo "────────────────────────────────────────────────────────────"
echo "🔑 Wizard Token:"
echo ""
echo "   ${TOKEN}"
echo ""
echo "────────────────────────────────────────────────────────────"
echo ""
echo "💡 Use this token to complete YouTrack setup wizard at:"
echo "   http://192.168.155.2:8080"
echo ""
echo "   Or via port forwarding:"
echo "   aws ssm start-session --target ${INSTANCE_ID} --region ${REGION} \\"
echo "     --document-name AWS-StartPortForwardingSession \\"
echo "     --parameters '{\"portNumber\":[\"8080\"],\"localPortNumber\":[\"8484\"]}'"
echo ""
echo "   Then access: http://localhost:8484"
echo ""
