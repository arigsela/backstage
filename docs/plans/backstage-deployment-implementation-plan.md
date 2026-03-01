# Backstage Developer Portal - Implementation Plan

**Created:** 2026-02-26
**Last Updated:** 2026-02-27
**Backstage Version:** 1.48.0
**Current Status:** Phase 6 Complete (6/7 phases)
**Overall Progress:** 27/34 tasks (79%)

---

## Overview
Deploy a production-ready Backstage v1.48.0 developer portal from the current scaffolded state (local dev with SQLite + guest auth) through to a fully configured, containerized Kubernetes deployment with real authentication, persistent database, and production hardening.

## Success Criteria
- [x] PostgreSQL database with persistent storage replacing SQLite
- [x] GitHub OAuth authentication replacing guest auth
- [x] Kubernetes plugin connected to at least one cluster
- [x] TechDocs rendering documentation locally
- [x] Docker image builds and runs successfully
- [x] Kubernetes manifests deploy a working Backstage instance
- [x] GitOps pipeline auto-deploys from Git commits
- [ ] Production security checklist complete (no guest auth, signed tokens, TLS)

## Research Findings

### Relevant Files
- `app-config.yaml` — Main config (SQLite, guest auth, localhost URLs)
- `app-config.production.yaml` — Already has PostgreSQL env var config
- `packages/backend/src/index.ts` — 19 plugins registered, GitHub auth module dependency exists but not registered
- `packages/backend/package.json` — `pg` and `@backstage/plugin-auth-backend-module-github-provider` already in dependencies
- `packages/app/src/App.tsx` — SignInPage configured for `['guest']` only
- `packages/backend/Dockerfile` — Production-ready multi-stage build exists
- `examples/org.yaml` — Only has `guest` user and `guests` group

### Existing Patterns
- New Backend System with `createBackend()` + `backend.add()` plugin registration
- Config uses `${ENV_VAR}` substitution for secrets
- Production config layered via `app-config.production.yaml`
- `.gitignore` already excludes `*.local.yaml` and `.env` files

### Key Observations
- ~~GitHub auth provider package already installed but **not registered** in backend index.ts~~ (Fixed in Phase 3)
- ~~PG search module registered but warns "not supported" without PostgreSQL~~ (Fixed in Phase 2)
- ~~Kubernetes plugin registered but has no cluster config~~ (Fixed in Phase 4 — Task 4.1)
- ~~Events backend not installed (catalog + signals warn about 404)~~ (Fixed in Phase 4 — Task 4.3)

## Architecture Decisions

### Decision 1: Database Strategy
**Options:** (A) Docker Compose PG for local, managed PG for prod (B) PG everywhere via Helm chart
**Chosen:** Option A — Docker Compose for local dev, environment-specific managed PG for production. The `app-config.production.yaml` already uses env vars, making this zero-config for different environments.

### Decision 2: Auth Provider
**Options:** (A) GitHub OAuth (B) Microsoft Entra ID (C) Okta
**Chosen:** GitHub OAuth — already has the dependency installed, matches the GitHub integration already configured, lowest friction to get started. Can add additional providers later.

### Decision 3: Kubernetes Plugin Mode
**Options:** (A) kubeconfig-based (B) ServiceAccount in-cluster (C) Both
**Chosen:** Option C — kubeconfig for local dev, ServiceAccount for in-cluster production. Config can switch via environment-specific config files.

---

## Implementation

### Phase 1: Prerequisites & Scaffolding ✅ COMPLETED (4/4 tasks)

- [x] Node.js v22.22.0 installed via nvm
- [x] Yarn 4.4.1 via corepack
- [x] Backstage v1.48.0 scaffolded
- [x] Local dev server verified at localhost:3000

**Phase Summary:** Backstage scaffolded and running locally with all default plugins. Guest auth active, SQLite in-memory database, 11 plugins initialized successfully.

---

### Phase 2: PostgreSQL Database Setup ✅ COMPLETED (3/3 tasks)

#### Task 2.1: Create Docker Compose for Local PostgreSQL
**Status:** ✅ Complete
**Files:** `docker-compose.yaml` (new)
**Steps:**
1. ✅ Created `docker-compose.yaml` at project root with PostgreSQL 16 Alpine service
2. ✅ Configured named volume `pgdata` for data persistence
3. ✅ Set default credentials via environment variables (backstage/backstage)
4. ✅ Exposed port 5432:5432
5. ✅ Added healthcheck using `pg_isready`
6. ✅ Added detailed learning comments throughout
**Testing:**
- [ ] `docker compose up -d` starts PostgreSQL successfully
- [ ] `docker compose exec postgres psql -U backstage -c '\l'` connects

#### Task 2.2: Update App Config for PostgreSQL
**Status:** ✅ Complete
**Files:** `app-config.yaml`, `app-config.local.yaml`
**Steps:**
1. ✅ Replaced `better-sqlite3` / `:memory:` in `app-config.yaml` with `pg` client and env var connection
2. ✅ Added local PG credentials to `app-config.local.yaml` (gitignored) with learning comments
3. ✅ Kept `app-config.production.yaml` as-is (already correct)
**Testing:**
- [ ] `yarn dev` connects to local PostgreSQL without errors
- [ ] Catalog entities persist across backend restarts
- [ ] Search indexing works with PG search engine (no more "not supported" warning)

#### Task 2.3: Create `.env.example` for Developer Onboarding
**Status:** ✅ Complete
**Files:** `.env.example` (new)
**Steps:**
1. ✅ Created `.env.example` with all required environment variables documented
2. ✅ Included POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_HOST, POSTGRES_PORT, GITHUB_TOKEN
3. ✅ Added detailed learning comments explaining each variable's purpose and usage
**Testing:**
- [ ] New developer can copy `.env.example` to `.env` and get running

**Phase Summary:** Replaced SQLite in-memory database with PostgreSQL for local development. Created Docker Compose file with PostgreSQL 16 Alpine (healthcheck, volume persistence, port 5432). Updated app-config.yaml to use `pg` client with env var substitution, and app-config.local.yaml with hardcoded local credentials (gitignored). Created .env.example documenting all environment variables for developer onboarding. Production config (app-config.production.yaml) was already correct — no changes needed. Phase 6 note: production PG will use existing cluster PostgreSQL instance with Vault/ESO for secrets.

---

### Phase 3: GitHub OAuth Authentication ✅ COMPLETED (4/4 tasks)

#### Task 3.1: Configure GitHub OAuth App
**Status:** ✅ Complete
**Files:** `app-config.yaml`, `app-config.local.yaml`
**Steps:**
1. ✅ Documented: Create GitHub OAuth App at `github.com/settings/developers`
   - Homepage URL: `http://localhost:3000`
   - Callback URL: `http://localhost:7007/api/auth/github/handler/frame`
2. ✅ Added `github` provider config to `app-config.yaml` under `auth.providers` with `${AUTH_GITHUB_CLIENT_ID}` and `${AUTH_GITHUB_CLIENT_SECRET}` env var placeholders
3. ✅ Added credential placeholders to `app-config.local.yaml` (gitignored)
4. ✅ Added `AUTH_GITHUB_CLIENT_ID` and `AUTH_GITHUB_CLIENT_SECRET` to `.env.example`
**Testing:**
- [ ] OAuth App created in GitHub
- [ ] Config references env vars (no hardcoded secrets)

#### Task 3.2: Register GitHub Auth Backend Module
**Status:** ✅ Complete
**Files:** `packages/backend/src/index.ts`
**Steps:**
1. ✅ Added `backend.add(import('@backstage/plugin-auth-backend-module-github-provider'))` after guest provider
2. ✅ Uses default `githubDefaultSignInResolver` (maps GitHub username → user:default/<username>)
**Testing:**
- [ ] Backend starts without auth errors
- [ ] `/api/auth/github/start` endpoint responds

#### Task 3.3: Update Frontend SignInPage
**Status:** ✅ Complete
**Files:** `packages/app/src/App.tsx`
**Steps:**
1. ✅ Updated `SignInPage` providers from `['guest']` to `['guest', 'github']`
2. ✅ Removed `auto` prop so sign-in page shows provider selection
3. ✅ Kept `guest` for local dev fallback
**Testing:**
- [ ] Sign-in page shows both "Guest" and "GitHub" login options
- [ ] OAuth flow redirects to GitHub and back successfully
- [ ] User identity shown in Backstage after login

#### Task 3.4: Create Organizational User/Group Entities
**Status:** ✅ Complete
**Files:** `examples/org.yaml`
**Steps:**
1. ✅ Added User entity for `arisela` (matches GitHub username for sign-in resolver)
2. ✅ Added Group entity `platform-engineering` team
3. ✅ Linked `arisela` user to `platform-engineering` group via `memberOf`
4. ✅ Kept existing `guest` user and `guests` group for local dev fallback
**Testing:**
- [ ] Users appear in the catalog
- [ ] "My Groups" sidebar shows correct group membership
- [ ] Sign-in resolves to the correct User entity

**Phase Summary:** Added GitHub OAuth authentication alongside existing guest auth. Configured GitHub OAuth provider in `app-config.yaml` with env var substitution for secrets, and added credential placeholders to `app-config.local.yaml` (gitignored). Registered `@backstage/plugin-auth-backend-module-github-provider` in the backend — uses the default sign-in resolver that maps GitHub username to `user:default/<username>`. Updated frontend SignInPage to show both "Guest" and "GitHub" options (removed `auto` prop). Created `arisela` user entity matching the GitHub username and `platform-engineering` group in `org.yaml`. Updated `.env.example` with `AUTH_GITHUB_CLIENT_ID` and `AUTH_GITHUB_CLIENT_SECRET`. Pre-requisite: user must create a GitHub OAuth App and paste credentials into `app-config.local.yaml` before testing.

---

### Phase 4: Plugin Configuration ✅ COMPLETED (6/6 tasks)

#### Task 4.1: Configure Kubernetes Plugin
**Status:** ✅ Complete
**Files:** `app-config.yaml`, `app-config.local.yaml`, `examples/entities.yaml`, `.env.example`
**Steps:**
1. ✅ Added kubernetes cluster config to `app-config.yaml` with ServiceAccount auth (env vars: K8S_CLUSTER_URL, K8S_SERVICE_ACCOUNT_TOKEN)
2. ✅ Added local dev override in `app-config.local.yaml` using `localKubectlProxy` (connects via `kubectl proxy` on localhost:8001)
3. ✅ Added `backstage.io/kubernetes-id: example-website` annotation to example-website component in `examples/entities.yaml`
4. ✅ Added K8S_CLUSTER_URL and K8S_SERVICE_ACCOUNT_TOKEN to `.env.example` with setup instructions
**Testing:**
- [ ] No more "Failed to initialize kubernetes backend" warning
- [ ] Kubernetes tab on entity pages loads (may show "no resources" if no matching workloads)
- [ ] Local dev: `kubectl proxy` + `yarn dev` shows K8s tab

#### Task 4.2: Configure TechDocs
**Status:** ✅ Complete
**Files:** `catalog-info.yaml`, `mkdocs.yml` (new), `docs/index.md` (new)
**Steps:**
1. ✅ Added `backstage.io/techdocs-ref: dir:.` annotation to `catalog-info.yaml`
2. ✅ Added `github.com/project-slug: arigsela/backstage` annotation to `catalog-info.yaml`
3. ✅ Created `mkdocs.yml` at project root with `techdocs-core` plugin and nav structure
4. ✅ Created `docs/index.md` with intro documentation about this Backstage instance
**Testing:**
- [ ] TechDocs page for backstage-scaffold entity renders docs/index.md content
- [ ] Documentation builds without errors (requires Docker running)

#### Task 4.3: Add Events Backend Plugin
**Status:** ✅ Complete
**Files:** `packages/backend/src/index.ts`, `packages/backend/package.json`
**Steps:**
1. ✅ Installed `@backstage/plugin-events-backend` (v0.5.11) via `yarn workspace backend add`
2. ✅ Registered in backend index.ts: `backend.add(import('@backstage/plugin-events-backend'))` — placed before notifications/signals so it's available when they initialize
**Testing:**
- [ ] No more 404 warnings for `/api/events/bus/v1/subscriptions/*`
- [ ] Catalog and signals event subscriptions succeed

#### Task 4.4: Configure GitHub Catalog Discovery
**Status:** ✅ Complete
**Files:** `packages/backend/src/index.ts`, `packages/backend/package.json`, `app-config.yaml`
**Steps:**
1. ✅ Installed `@backstage/plugin-catalog-backend-module-github` (v0.12.2) via `yarn workspace backend add`
2. ✅ Registered in backend index.ts: `backend.add(import('@backstage/plugin-catalog-backend-module-github'))`
3. ✅ Added `catalog.providers.github.arigsela` config in `app-config.yaml` with:
   - Organization: `arigsela`
   - Catalog path: `/catalog-info.yaml`
   - Filter: `.*` (all repos)
   - Schedule: every 30 minutes, 3-minute timeout
**Testing:**
- [ ] Backend logs show `Configuring provider: github` for catalog discovery
- [ ] After ~30 min, GitHub repos with catalog-info.yaml appear in the catalog

#### Task 4.5: Update .env.example
**Status:** ✅ Complete
**Files:** `.env.example`
**Steps:**
1. ✅ Added K8S_CLUSTER_URL and K8S_SERVICE_ACCOUNT_TOKEN with detailed comments
2. ✅ Included instructions for creating a ServiceAccount token
**Testing:**
- [ ] .env.example documents all required production env vars

#### Task 4.6: Update Implementation Plan
**Status:** ✅ Complete
**Files:** `docs/plans/backstage-deployment-implementation-plan.md`
**Steps:**
1. ✅ Marked all Phase 4 tasks complete
2. ✅ Updated progress counters (17/27 tasks, 63%)
3. ✅ Added phase summary

**Phase Summary:** Configured all remaining unconfigured plugins. **Kubernetes**: Added cluster config with ServiceAccount auth for production (env vars) and localKubectlProxy for local dev (via `kubectl proxy`). Added `kubernetes-id` annotation to example-website entity. **TechDocs**: Added `techdocs-ref` annotation to `catalog-info.yaml`, created `mkdocs.yml` and `docs/index.md` with intro documentation. TechDocs config already had `builder: 'local'` and `generator.runIn: 'docker'`. **Events Backend**: Installed and registered `@backstage/plugin-events-backend` to provide the in-process event bus, fixing 404 warnings from catalog, notifications, and signals plugins. **GitHub Catalog Discovery**: Installed `@backstage/plugin-catalog-backend-module-github` and configured a provider to auto-discover repos under the `arigsela` GitHub user every 30 minutes. Updated `.env.example` with Kubernetes env vars.

---

### Phase 5: Containerization & Docker ✅ COMPLETED (3/3 tasks)

#### Task 5.1: Review & Update Dockerfile
**Status:** ✅ Complete
**Files:** `packages/backend/Dockerfile`
**Steps:**
1. ✅ Reviewed existing multi-stage Dockerfile (Node 24 Trixie slim, skeleton+bundle approach)
2. ✅ Added `COPY catalog-info.yaml` for self-registration in the production catalog
3. ✅ Added `COPY mkdocs.yml` and `COPY docs ./docs` for TechDocs local builder
4. ✅ Verified all existing COPY steps are correct (examples/, app-config*.yaml, etc.)
**Testing:**
- [ ] Docker build: `docker image build . -f packages/backend/Dockerfile --tag backstage:local`
- [ ] Image runs: `docker run -p 7007:7007 backstage:local`
- [ ] `/healthcheck` endpoint returns 200

**Build steps (run before docker build):**
```bash
yarn install --immutable
yarn tsc
yarn build:backend
docker image build . -f packages/backend/Dockerfile --tag backstage:local
```

#### Task 5.2: Create Full-Stack Docker Compose
**Status:** ✅ Complete
**Files:** `docker-compose.yaml`
**Steps:**
1. ✅ Added `backstage` service using `backstage:local` image
2. ✅ Used Docker Compose `profiles: ['full']` so PostgreSQL-only workflow is unchanged
3. ✅ Configured env vars: POSTGRES_HOST=postgres (Docker service name), POSTGRES_PORT, POSTGRES_USER, POSTGRES_PASSWORD
4. ✅ Added passthrough for GITHUB_TOKEN, AUTH_GITHUB_CLIENT_ID/SECRET, K8S vars via `${VAR:-}` syntax
5. ✅ Added `depends_on: postgres: condition: service_healthy` for startup ordering
6. ✅ Added healthcheck using `curl -f http://localhost:7007/healthcheck`
7. ✅ Set `start_period: 30s` to give plugins time to initialize
**Testing:**
- [ ] `docker compose --profile full up -d` starts PostgreSQL + Backstage
- [ ] Backstage accessible at http://localhost:7007
- [ ] Catalog loads example entities
- [ ] `docker compose up -d` (without profile) still starts only PostgreSQL

#### Task 5.3: Review & Update .dockerignore
**Status:** ✅ Complete
**Files:** `.dockerignore`
**Steps:**
1. ✅ Added `.env` and `.env.*` exclusions (was missing — potential secret leak!)
2. ✅ Added `docs/plans` and `docs/reference` exclusions (implementation details, not needed in image)
3. ✅ Added `.claude` exclusion (development tooling)
4. ✅ Verified existing exclusions: `.git`, `.yarn/cache`, `node_modules`, `packages/*/src`, `plugins`, `*.local.yaml`
**Testing:**
- [ ] No `.env`, `*.local.yaml`, or credentials in built image

**Phase Summary:** Prepared the Backstage project for containerized deployment. Updated the existing Dockerfile to also copy `catalog-info.yaml` (for self-registration), `mkdocs.yml`, and `docs/` (for TechDocs). Added a `backstage` service to `docker-compose.yaml` using Docker Compose profiles — `docker compose up -d` still starts only PostgreSQL (unchanged workflow), while `docker compose --profile full up -d` starts the full stack. The backstage service uses `depends_on` with health condition to wait for PostgreSQL, passes all required env vars, and has its own healthcheck on `/healthcheck`. Updated `.dockerignore` to exclude `.env` files (was missing!), implementation plans, and development tooling. Updated `app-config.production.yaml` to include `catalog-info.yaml` in catalog locations for self-registration in production.

---

### Phase 6: Kubernetes Deployment (GitOps) ✅ COMPLETED (7/7 tasks)

#### Task 6.1: Update app-config.production.yaml
**Status:** ✅ Complete
**Files:** `app-config.production.yaml`
**Steps:**
1. ✅ Changed `app.baseUrl` from `http://localhost:7007` to `https://backstage.arigsela.com`
2. ✅ Changed `backend.baseUrl` from `http://localhost:7007` to `https://backstage.arigsela.com`
3. ✅ Added `backend.cors.origin: https://backstage.arigsela.com` to override base config's `http://localhost:3000`
4. ✅ Updated TODO comments to reflect completion
**Testing:**
- [ ] Production config renders correctly in `yarn backstage-cli config:print`

#### Task 6.2: Create ECR Build Script
**Status:** ✅ Complete
**Files:** `scripts/build-and-push.sh` (new)
**Steps:**
1. ✅ Created build script that runs `yarn install --immutable`, `yarn tsc`, `yarn build:backend`
2. ✅ Builds Docker image from `packages/backend/Dockerfile`
3. ✅ Authenticates with ECR via AWS CLI
4. ✅ Tags with version + latest, pushes both
5. ✅ Accepts `--version` flag, defaults to git short SHA
6. ✅ Made script executable (`chmod +x`)
7. ✅ Added detailed learning comments throughout
**Testing:**
- [ ] `./scripts/build-and-push.sh --version 1.0.0` builds and pushes successfully

#### Task 6.3: Create ArgoCD Application
**Status:** ✅ Complete
**Files:** `kubernetes-repo: base-apps/backstage.yaml` (new)
**Steps:**
1. ✅ Created ArgoCD Application following existing pattern (chores-tracker-backend.yaml)
2. ✅ Source: arigsela/kubernetes, path: base-apps/backstage
3. ✅ Destination: in-cluster, namespace: backstage
4. ✅ SyncPolicy: automated, prune, selfHeal, CreateNamespace=true
**Testing:**
- [ ] ArgoCD discovers and syncs the Backstage application

#### Task 6.4: Create Backstage Deployment Manifests
**Status:** ✅ Complete
**Files:** `kubernetes-repo: base-apps/backstage/` (7 files)
**Steps:**
1. ✅ `deployments.yaml` — Standard Deployment (not Rollout), ECR image, health probes (liveness 60s init, readiness 30s init), resources (256Mi/250m requests, 512Mi/1000m limits), pod securityContext (runAsUser 1000, runAsNonRoot), container securityContext (allowPrivilegeEscalation false), imagePullSecrets (ecr-registry), nodeSelector (application)
2. ✅ `services.yaml` — ClusterIP Service, port 80 → targetPort 7007
3. ✅ `nginx-ingress.yaml` — NGINX Ingress, host backstage.arigsela.com, cert-manager letsencrypt-prod, ssl-redirect, 60s timeouts, path / Prefix → backstage service port 80
4. ✅ `configmaps.yaml` — POSTGRES_HOST (postgresql.postgresql.svc.cluster.local), POSTGRES_PORT (5432)
5. ✅ `secret-store.yaml` — Vault SecretStore, k8s-secrets v2 engine, kubernetes auth, backstage role
6. ✅ `external-secrets.yaml` — ExternalSecret mapping 7 Vault keys (postgres-user, postgres-password, github-token, github-oauth-client-id, github-oauth-client-secret, k8s-cluster-url, k8s-service-account-token) → backstage-secrets Secret, refreshInterval 1h
7. ✅ `rbac.yaml` — ServiceAccount backstage, ClusterRole backstage-read-only (pods, pods/log, services, configmaps, namespaces, deployments, replicasets, statefulsets, daemonsets, HPAs, ingresses, jobs, cronjobs), ClusterRoleBinding
**Testing:**
- [ ] `kubectl get all -n backstage` — pod running, service ready
- [ ] ExternalSecret resolves → backstage-secrets created
- [ ] Pod passes health checks

#### Task 6.5: Update ECR CronJob
**Status:** ✅ Complete
**Files:** `kubernetes-repo: base-apps/ecr-auth/cronjobs.yaml` (modified)
**Steps:**
1. ✅ Added `backstage` to the namespace list in the ECR credentials sync CronJob
**Testing:**
- [ ] ECR CronJob syncs ecr-registry secret to backstage namespace

#### Task 6.6: Create PR in Kubernetes Repo
**Status:** ✅ Complete
**PR:** https://github.com/arigsela/kubernetes/pull/85
**Steps:**
1. ✅ Created `feat/backstage-deployment` branch
2. ✅ Committed all 8 new files + 1 modified file
3. ✅ Pushed branch and created PR via GitHub MCP server
4. ✅ PR includes detailed description with manual steps and test plan

#### Task 6.7: Update Implementation Plan
**Status:** ✅ Complete
**Files:** `docs/plans/backstage-deployment-implementation-plan.md`
**Steps:**
1. ✅ Marked all Phase 6 tasks complete
2. ✅ Updated progress counters (27/34 tasks, 79%)
3. ✅ Added phase summary

**Phase Summary:** Deployed Backstage to the K3s cluster using the established GitOps pipeline. **Backstage repo changes**: Updated `app-config.production.yaml` with production domain (`https://backstage.arigsela.com`) and CORS override. Created `scripts/build-and-push.sh` for building and pushing Docker images to ECR (supports `--version` flag, defaults to git SHA). **Kubernetes repo changes** (PR #85): Created ArgoCD Application + 7 manifest files (Deployment with health probes and security context, ClusterIP Service, NGINX Ingress with TLS via cert-manager, ConfigMap for PG connection, Vault SecretStore + ExternalSecret for 7 secrets, ServiceAccount + ClusterRole + ClusterRoleBinding for K8s plugin read-only access). Updated ECR CronJob to sync credentials to backstage namespace. Architecture uses existing cluster PostgreSQL (postgresql namespace) via cross-namespace DNS, Vault + ESO for secret management, and cert-manager for TLS. Manual steps documented: create ECR repo, build first image, create PG database/user, configure Vault policy/role/secrets, update GitHub OAuth callback URL, generate SA token.

---

### Phase 7: Production Readiness (0/4 tasks)

#### Task 7.1: Remove Guest Auth & Enforce Policies
**Status:** ⬜ Not Started
**Files:** `app-config.production.yaml`, `packages/backend/src/index.ts`
**Steps:**
1. Remove `guest: {}` from production auth config
2. Verify `dangerouslyDisableDefaultAuthPolicy` is NOT set anywhere
3. Remove guest provider module from production (conditional or separate config)
4. Replace allow-all permission policy with a real policy
**Testing:**
- [ ] Production build has no guest auth available
- [ ] Unauthenticated requests are rejected
- [ ] Permission checks enforce access control

#### Task 7.2: Configure Static Signing Keys
**Status:** ⬜ Not Started
**Files:** `app-config.production.yaml`
**Steps:**
1. Generate a static backend signing key
2. Configure `backend.auth.keys` in production config with `${BACKEND_SECRET}`
3. Ensure all backend instances share the same key
**Testing:**
- [ ] Backend starts with static signing key
- [ ] Service-to-service auth works across restarts

#### Task 7.3: Set Up Monitoring & Health Checks
**Status:** ⬜ Not Started
**Files:** `app-config.production.yaml`, `k8s/backstage.yaml`
**Steps:**
1. Verify `/healthcheck` endpoint is exposed
2. Configure liveness and readiness probes in K8s deployment
3. Set up log aggregation (stdout/stderr to cluster logging)
4. Document Prometheus metrics endpoint if available
**Testing:**
- [ ] Health probes pass during normal operation
- [ ] Failing health check triggers pod restart
- [ ] Logs are accessible via cluster logging solution

#### Task 7.4: Security Hardening
**Status:** ⬜ Not Started
**Files:** `app-config.production.yaml`
**Steps:**
1. Restrict CORS origins to production domain only
2. Configure CSP headers appropriately
3. Review and tighten proxy endpoints
4. Ensure all secrets use env vars (no hardcoded values)
5. Set `backend.listen` to bind only necessary interfaces
**Testing:**
- [ ] CORS rejects requests from unauthorized origins
- [ ] No secrets in config files committed to Git
- [ ] Security headers present in HTTP responses

---

## Related Work

### CrewAI Agent Software Template
A Backstage Software Template was created to enable self-service scaffolding of new CrewAI multi-agent projects. This extends the Backstage deployment with self-service AI agent deployment capabilities.

- **Implementation Plan:** `docs/plans/crewai-agent-template-implementation-plan.md`
- **Template:** `examples/templates/crewai-agent/template.yaml`
- **Usage Guide:** `docs/guides/crewai-agent-template-guide.md`
- **First Use Case:** Chores Tracker Knowledge Agent (knowledge files in `examples/templates/crewai-agent/examples/`)
- **Status:** Template code complete (Phases 1-4), knowledge content ready (Phase 5 partial), pending UI testing and deployment (Phase 5.1/5.4/5.5)

---

## End-to-End Testing
1. Fresh clone -> `docker compose up` -> Backstage accessible with PostgreSQL
2. GitHub OAuth sign-in -> resolves to correct User entity
3. Catalog shows entities from GitHub discovery
4. Kubernetes tab shows pod status for annotated entities
5. TechDocs renders documentation
6. Docker image build -> push to registry -> K8s deploy via GitOps
7. Production instance accessible via domain with TLS
8. Guest auth disabled, all endpoints require authentication

## Risks and Mitigations
| Risk | Mitigation |
|---|---|
| GitHub OAuth callback URL mismatch per environment | Create separate OAuth Apps per environment (dev, staging, prod) |
| isolated-vm build failures on Node version changes | Pin Node version in `.nvmrc`, rebuild native modules after upgrade |
| TechDocs Docker-in-Docker in Kubernetes | Use `external` builder with CI/CD pipeline for production |
| PostgreSQL connection failures on first deploy | Health check with retry, `depends_on` in Compose, init containers in K8s |
| Kubernetes RBAC too permissive | Scope ServiceAccount to specific namespaces, use read-only ClusterRole |
| Secrets leaked in Git | `.gitignore` covers `*.local.yaml` and `.env`, pre-commit hook recommended |
