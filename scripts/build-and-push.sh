#!/usr/bin/env bash
# ==============================================================================
# Backstage ECR Build & Push Script
# ==============================================================================
#
# Builds the Backstage backend Docker image and pushes it to Amazon ECR.
#
# WHAT THIS SCRIPT DOES:
# 1. Installs dependencies (yarn install --immutable ensures lockfile is respected)
# 2. Type-checks the project (yarn tsc catches TypeScript errors before building)
# 3. Builds the backend bundle (yarn build:backend creates the production bundle)
# 4. Builds the Docker image using the multi-stage Dockerfile
# 5. Authenticates with ECR (uses AWS CLI credentials from your environment)
# 6. Tags the image with both a version tag and :latest
# 7. Pushes both tags to ECR
#
# USAGE:
#   ./scripts/build-and-push.sh                  # Uses git short SHA as version
#   ./scripts/build-and-push.sh --version 1.0.0  # Uses explicit version tag
#
# PREREQUISITES:
# - AWS CLI configured with credentials that have ECR push access
# - Docker running
# - Node.js and Yarn installed (for the build steps)
# ==============================================================================

set -euo pipefail

# --- Configuration ---
# ECR registry and repository details.
# The AWS account ID and region are specific to this project's infrastructure.
ECR_REGISTRY="852893458518.dkr.ecr.us-east-2.amazonaws.com"
ECR_REPO="backstage-portal"
AWS_REGION="us-east-2"

# --- Parse Arguments ---
# Accept an optional --version flag; default to the current git short SHA.
# Using the git SHA ties each image to a specific commit, making it easy to
# trace which code is running in production.
VERSION=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --version)
      VERSION="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--version <version>]"
      exit 1
      ;;
  esac
done

# Default to git short SHA if no version was provided.
# This is the most common workflow: build from current commit.
if [ -z "$VERSION" ]; then
  VERSION=$(git rev-parse --short HEAD)
  echo "No --version specified, using git SHA: ${VERSION}"
fi

FULL_IMAGE="${ECR_REGISTRY}/${ECR_REPO}"

echo "============================================"
echo "Building Backstage Portal"
echo "  Version: ${VERSION}"
echo "  Image:   ${FULL_IMAGE}:${VERSION}"
echo "============================================"

# --- Step 1: Install Dependencies ---
# --immutable ensures the lockfile is not modified during install.
# This guarantees reproducible builds — if someone added a dependency
# without updating yarn.lock, the build fails here instead of silently
# using a different version.
echo ""
echo ">>> Step 1/6: Installing dependencies..."
yarn install --immutable

# --- Step 2: Type Check ---
# Run the TypeScript compiler to catch type errors before building.
# This prevents shipping broken code to production.
echo ""
echo ">>> Step 2/6: Type checking..."
yarn tsc

# --- Step 3: Build Backend ---
# Creates the production backend bundle in packages/backend/dist/.
# This is what gets copied into the Docker image.
echo ""
echo ">>> Step 3/6: Building backend..."
yarn build:backend

# --- Step 4: Build Docker Image ---
# Uses the multi-stage Dockerfile at packages/backend/Dockerfile.
# The Dockerfile copies the pre-built bundle (not source code),
# resulting in a smaller, faster image.
echo ""
echo ">>> Step 4/6: Building Docker image..."
docker image build . -f packages/backend/Dockerfile --tag "${ECR_REPO}:latest"

# --- Step 5: Authenticate with ECR ---
# ECR tokens expire after 12 hours. This command fetches a fresh token
# from AWS and pipes it to docker login. The AWS CLI uses whatever
# credentials are in your environment (env vars, ~/.aws/credentials, or IAM role).
echo ""
echo ">>> Step 5/6: Logging in to ECR..."
aws ecr get-login-password --region "${AWS_REGION}" | \
  docker login --username AWS --password-stdin "${ECR_REGISTRY}"

# --- Step 6: Tag and Push ---
# We push two tags:
# 1. The version tag (e.g., :1.0.0 or :abc1234) for rollback and traceability
# 2. The :latest tag so Kubernetes can pull the newest image
echo ""
echo ">>> Step 6/7: Tagging and pushing..."
docker tag "${ECR_REPO}:latest" "${FULL_IMAGE}:${VERSION}"
docker tag "${ECR_REPO}:latest" "${FULL_IMAGE}:latest"
docker push "${FULL_IMAGE}:${VERSION}"
docker push "${FULL_IMAGE}:latest"

echo ""
echo ">>> Step 7/7: Rolling out deployment..."
kubectl rollout restart deployment/backstage -n backstage
kubectl rollout status deployment/backstage -n backstage --timeout=120s

echo ""
echo "============================================"
echo "Successfully pushed and deployed:"
echo "  ${FULL_IMAGE}:${VERSION}"
echo "  ${FULL_IMAGE}:latest"
echo "============================================"
