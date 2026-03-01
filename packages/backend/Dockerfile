# ==============================================================================
# Backstage Backend Dockerfile
# ==============================================================================
#
# PURPOSE:
# Builds a production Docker image for the Backstage backend. This image serves
# both the backend API (port 7007) and the bundled frontend (via app-backend plugin).
#
# PREREQUISITES (run these BEFORE building the image):
#   yarn install --immutable   # Install dependencies
#   yarn tsc                   # TypeScript compilation
#   yarn build:backend         # Bundle the backend (creates dist/skeleton.tar.gz + bundle.tar.gz)
#
# BUILD COMMAND:
#   docker image build . -f packages/backend/Dockerfile --tag backstage:local
#   — OR —
#   yarn build-image           # Shortcut defined in packages/backend/package.json
#
# IMPORTANT: Docker context must be the repo root (not packages/backend/)
# because we need access to yarn.lock, .yarn/, and other root-level files.
#
# BUILD STRATEGY:
# Backstage uses a "skeleton + bundle" approach for efficient Docker caching:
# 1. skeleton.tar.gz — Contains only package.json files (dependency metadata)
# 2. bundle.tar.gz — Contains the actual compiled code
# By copying the skeleton first and running yarn install, Docker can cache the
# expensive dependency installation step. Code changes only invalidate the
# bundle copy step, making rebuilds fast.
# ==============================================================================

# Base image: Node.js 24 on Debian Trixie (slim variant for smaller image size)
FROM node:24-trixie-slim

# Python is required by node-gyp, which compiles native Node.js addons.
# Several Backstage dependencies (isolate-vm, better-sqlite3) use native code.
ENV PYTHON=/usr/bin/python3

# NATIVE BUILD DEPENDENCIES:
# The scaffolder plugin uses `isolate-vm` (a V8 isolate for sandboxing),
# which requires compilation from C++ source during `yarn install`.
# --mount=type=cache: Reuses the apt cache across builds (BuildKit feature)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends python3 g++ build-essential && \
    rm -rf /var/lib/apt/lists/*

# SQLITE DEPENDENCIES:
# The `better-sqlite3` package needs libsqlite3-dev to compile.
# NOTE: In production with PostgreSQL, SQLite is a fallback. You could remove
# this and move better-sqlite3 to devDependencies if you're PG-only.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends libsqlite3-dev && \
    rm -rf /var/lib/apt/lists/*

# SECURITY: Run as non-root user.
# The `node` user (uid 1000) comes pre-created in the Node.js base image.
# All subsequent operations run as this unprivileged user.
USER node

# Create the app directory owned by `node`.
# IMPORTANT: With BuildKit enabled, WORKDIR respects the current USER,
# so /app is created as node:node. Without BuildKit, it's created as root
# and the tar extraction below will fail with permission errors.
WORKDIR /app

# YARN CONFIGURATION:
# Copy Yarn's PnP (Plug'n'Play) configuration and cache.
# .yarn/ contains the Yarn binary and plugin cache.
# .yarnrc.yml configures Yarn settings (nodeLinker, etc.)
# --chown=node:node ensures the non-root user owns these files.
COPY --chown=node:node .yarn ./.yarn
COPY --chown=node:node .yarnrc.yml ./
COPY --chown=node:node backstage.json ./

# Production mode: disables devDependencies and enables optimizations.
ENV NODE_ENV=production

# Disable Node.js snapshots — required for isolate-vm (used by the scaffolder).
ENV NODE_OPTIONS="--no-node-snapshot"

# SKELETON COPY + DEPENDENCY INSTALL (cacheable layer):
# The skeleton.tar.gz contains only package.json files from the monorepo.
# Combined with yarn.lock and root package.json, this is enough to install
# all production dependencies. Because dependencies change less frequently
# than code, Docker can cache this expensive layer.
COPY --chown=node:node yarn.lock package.json packages/backend/dist/skeleton.tar.gz ./
RUN tar xzf skeleton.tar.gz && rm skeleton.tar.gz

# Install production dependencies only (no devDependencies).
# --mount=type=cache: Caches Yarn's download cache across builds.
# `yarn workspaces focus --all --production` installs only production deps.
RUN --mount=type=cache,target=/home/node/.cache/yarn,sharing=locked,uid=1000,gid=1000 \
    yarn workspaces focus --all --production && rm -rf "$(yarn cache clean)"

# Copy example catalog entities into the image.
# These are referenced by app-config.production.yaml catalog locations.
# Remove this line if you're using external catalog sources (GitHub, etc.)
COPY --chown=node:node examples ./examples

# Copy catalog-info.yaml for self-registration in the catalog.
# This lets the Backstage instance register itself as a Component entity.
COPY --chown=node:node catalog-info.yaml ./

# Copy TechDocs source files for the local docs builder.
# mkdocs.yml defines the docs structure, docs/ contains the Markdown content.
# NOTE: In production, consider switching to the 'external' TechDocs builder
# (pre-build docs in CI/CD) to avoid needing Docker-in-Docker.
COPY --chown=node:node mkdocs.yml ./
COPY --chown=node:node docs ./docs

# BUNDLE COPY (invalidated on code changes):
# bundle.tar.gz contains the compiled backend code.
# app-config*.yaml copies all config files (base + production).
# Note: .dockerignore excludes *.local.yaml to prevent secrets in the image.
COPY --chown=node:node packages/backend/dist/bundle.tar.gz app-config*.yaml ./
RUN tar xzf bundle.tar.gz && rm bundle.tar.gz

# START THE BACKEND:
# Loads both config files — base config first, then production overrides.
# The --config flags are processed left-to-right, with later files winning.
# So app-config.production.yaml overrides app-config.yaml where they overlap.
CMD ["node", "packages/backend", "--config", "app-config.yaml", "--config", "app-config.production.yaml"]
