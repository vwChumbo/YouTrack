#!/bin/bash
set -e

# Usage: ./scripts/update-youtrack-image.sh [VERSION]
# Example: ./scripts/update-youtrack-image.sh 2024.4

VERSION=${1:-2024.3}
ECR_REGISTRY="640664844884.dkr.ecr.eu-west-1.amazonaws.com"
ECR_REPO="youtrack"
IMAGE_TAG="${VERSION}"

echo "🔄 Updating YouTrack image in ECR to version ${VERSION}"

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
  echo "❌ Error: Docker is not running"
  exit 1
fi

# Pull new version from Docker Hub
echo "📥 Pulling jetbrains/youtrack:${VERSION} from Docker Hub..."
docker pull jetbrains/youtrack:${VERSION}

# Login to ECR
echo "🔑 Logging in to ECR..."
aws ecr get-login-password --region eu-west-1 | \
  docker login --username AWS --password-stdin ${ECR_REGISTRY}

# Tag for ECR
echo "🏷️  Tagging image for ECR..."
docker tag jetbrains/youtrack:${VERSION} ${ECR_REGISTRY}/${ECR_REPO}:${IMAGE_TAG}

# Check if this is the latest version being pushed
read -p "Is this the latest version? Tag as 'latest' too? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  docker tag jetbrains/youtrack:${VERSION} ${ECR_REGISTRY}/${ECR_REPO}:latest
  echo "📤 Pushing ${ECR_REGISTRY}/${ECR_REPO}:latest..."
  docker push ${ECR_REGISTRY}/${ECR_REPO}:latest
fi

# Push to ECR
echo "📤 Pushing ${ECR_REGISTRY}/${ECR_REPO}:${IMAGE_TAG} to ECR..."
docker push ${ECR_REGISTRY}/${ECR_REPO}:${IMAGE_TAG}

# Verify upload
echo "✅ Verifying upload..."
aws ecr describe-images \
  --repository-name ${ECR_REPO} \
  --region eu-west-1 \
  --image-ids imageTag=${IMAGE_TAG} \
  --query 'imageDetails[0].[imageTags[0],imageSizeInBytes,imagePushedAt]' \
  --output table

echo ""
echo "✅ YouTrack ${VERSION} successfully pushed to ECR!"
echo ""
echo "📝 To update the running instance:"
echo "   1. SSH via SSM: aws ssm start-session --target <instance-id> --region eu-west-1"
echo "   2. Stop container: docker stop youtrack && docker rm youtrack"
echo "   3. Pull new image: docker pull ${ECR_REGISTRY}/${ECR_REPO}:${IMAGE_TAG}"
echo "   4. Start container: docker run -d --name youtrack --restart=always -p 8080:8080 -v /var/youtrack-data:/opt/youtrack/data ${ECR_REGISTRY}/${ECR_REPO}:${IMAGE_TAG}"
echo ""
echo "Or redeploy the stack after updating the image tag in lib/youtrack-stack.ts"
