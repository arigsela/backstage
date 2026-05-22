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
# 3. Builds all packages (yarn build:all — frontend + backend; backend bundle
#    pulls the frontend's static assets into its tar archive)
# 4. Authenticates with ECR (must happen before push)
# 5. Builds & pushes the Docker image using buildx, targeting the cluster's
#    architecture (linux/amd64 by default). Both the version tag and :latest
#    are produced in a single buildx invocation.
# 6. Restarts the Kubernetes deployment so it pulls the new image.
#
# USAGE:
#   ./scripts/build-and-push.sh                       # Uses git short SHA as version
#   ./scripts/build-and-push.sh --version v1.0.2      # Explicit version tag
#   ./scripts/build-and-push.sh --platform linux/arm64 # Override target arch
#
# WHY buildx:
#   The Dockerfile uses BuildKit features (`RUN --mount=type=cache`) and we
#   build on Apple Silicon while the cluster nodes are amd64. buildx supports
#   both — it cross-compiles via QEMU/Rosetta and pushes a manifest matching
#   the requested platform.
#
# PREREQUISITES:
# - AWS CLI configured with credentials that have ECR push access
# - Docker running (Colima or Docker Desktop) with the buildx CLI plugin
#     brew install docker-buildx
#     ln -sfn "$(brew --prefix)/opt/docker-buildx/bin/docker-buildx" \
#             ~/.docker/cli-plugins/docker-buildx
# - Node.js and Yarn (Corepack) installed for the build steps
# - kubectl context pointing at the target cluster
# ==============================================================================

set -euo pipefail

# --- Configuration ---
# ECR registry and repository details.
# The AWS account ID and region are specific to this project's infrastructure.
ECR_REGISTRY="852893458518.dkr.ecr.us-east-2.amazonaws.com"
ECR_REPO="backstage-portal"
AWS_REGION="us-east-2"

# Default target platform for the image. The k3s cluster nodes run amd64,
# so even when building from an arm64 Mac we must produce an amd64 image,
# otherwise pods fail with "no match for platform in manifest".
DEFAULT_PLATFORM="linux/amd64"

# --- Parse Arguments ---
# --version : tag to push (defaults to git short SHA)
# --platform: docker target platform (defaults to linux/amd64)
VERSION=""
PLATFORM="${DEFAULT_PLATFORM}"
while [[ $# -gt 0 ]]; do
  case $1 in
    --version)
      VERSION="$2"
      shift 2
      ;;
    --platform)
      PLATFORM="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--version <version>] [--platform <os/arch>]"
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

# --- Preflight: buildx must be installed ---
# The Dockerfile uses --mount=type=cache (BuildKit-only) and we cross-build
# for amd64 from arm64 hosts, both of which require the buildx plugin.
if ! docker buildx version >/dev/null 2>&1; then
  echo "ERROR: 'docker buildx' is not available."
  echo "Install it with:"
  echo "  brew install docker-buildx"
  echo "  ln -sfn \"\$(brew --prefix)/opt/docker-buildx/bin/docker-buildx\" \\"
  echo "          ~/.docker/cli-plugins/docker-buildx"
  exit 1
fi

echo "============================================"
echo "Building Backstage Portal"
echo "  Version:  ${VERSION}"
echo "  Platform: ${PLATFORM}"
echo "  Image:    ${FULL_IMAGE}:${VERSION}"
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

# --- Step 3: Build All Packages (frontend + backend) ---
# Builds every workspace in the repo: packages/app (frontend), packages/backend
# (server), and any others. Necessary because the backend bundles the frontend's
# static assets into its image — if we only ran `yarn build:backend`, frontend
# changes wouldn't reach production. The backend's bundle.tar.gz pulls from
# packages/app/dist/, which only exists after the app build runs.
echo ""
echo ">>> Step 3/6: Building all packages (frontend + backend)..."
yarn build:all

# --- Step 4: Authenticate with ECR ---
# ECR tokens expire after 12 hours. This command fetches a fresh token
# from AWS and pipes it to docker login. The AWS CLI uses whatever
# credentials are in your environment (env vars, ~/.aws/credentials, or IAM role).
# Login must happen BEFORE the buildx --push step below.
echo ""
echo ">>> Step 4/6: Logging in to ECR..."
aws ecr get-login-password --region "${AWS_REGION}" | \
  docker login --username AWS --password-stdin "${ECR_REGISTRY}"

# --- Step 5: Build & Push Docker Image (buildx) ---
# Single buildx invocation that:
#   * targets ${PLATFORM} (default linux/amd64 to match cluster nodes)
#   * applies BOTH the version tag and :latest
#   * pushes directly to ECR (--push) so we never load the cross-arch image
#     into the local Docker store (which can't run it natively anyway).
#
# --provenance=false suppresses the "unknown/unknown" attestation manifest
# that BuildKit otherwise adds to the index — keeps the manifest list clean
# with only the platforms we actually built.
echo ""
echo ">>> Step 5/6: Building & pushing Docker image (${PLATFORM})..."
docker buildx build \
  --platform="${PLATFORM}" \
  --provenance=false \
  -f packages/backend/Dockerfile \
  -t "${FULL_IMAGE}:${VERSION}" \
  -t "${FULL_IMAGE}:latest" \
  --push \
  .

# --- Step 6: Roll Out Deployment ---
# Restart triggers a fresh pull of :latest (or the pinned version, depending
# on what the deployment manifest references) and a rolling update.
echo ""
echo ">>> Step 6/6: Rolling out deployment..."
kubectl rollout restart deployment/backstage -n backstage
kubectl rollout status deployment/backstage -n backstage --timeout=120s

echo ""
echo "============================================"
echo "Successfully pushed and deployed:"
echo "  ${FULL_IMAGE}:${VERSION}"
echo "  ${FULL_IMAGE}:latest"
echo "============================================"
