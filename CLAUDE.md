# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A [Backstage](https://backstage.io) developer portal (v1.52) for a homelab/k3s
platform, deployed as `backstage-portal` on the cluster. Beyond stock Backstage,
the substantive custom work here is an **IDP integration with
[kagent.dev](https://kagent.dev) AI agents** — scaffolder actions, an interactive
form field, and a catalog annotation contract that makes agents queryable as
first-class catalog entities.

Node 22 or 24, Yarn 4 (Corepack), PostgreSQL 16.

## Commands

```bash
yarn install                 # Yarn 4 via corepack; --immutable in CI/builds
docker compose up -d         # PostgreSQL 16 on :5432 (required before start)
yarn start                   # Frontend :3000 + backend :7007 (backstage-cli repo start)
yarn start app               # Frontend only
yarn start backend           # Backend only

yarn tsc                     # Type check (incremental); yarn tsc:full for a cold, non-skipLibCheck run
yarn test                    # All workspaces (jest under backstage-cli)
yarn test:all                # With coverage
yarn test:e2e                # Playwright; auto-starts app+backend unless CI=1
yarn lint:all                # Lint everything — PREFER THIS (see caveat below)
yarn prettier:check
yarn fix                     # backstage-cli repo fix — auto-fixes lint + generated files
yarn new                     # Scaffold a new plugin/package into plugins/ or packages/
```

**Running a single test** — args pass through to jest:

```bash
yarn workspace backend test src/modules/kagent-shared/resolver.test.ts
yarn workspace backend test -t 'throws when the app directory exists'
yarn workspace app test src/scaffolder/KagentSuggestField
```

**`yarn lint` is broken here.** It runs `--since origin/master`, but this repo's
default branch is `main` and `origin/master` does not exist, so it exits with
`git diff failed, fatal: ambiguous argument 'origin/master'`. Use `yarn lint:all`, or
`yarn backstage-cli repo lint --since origin/main`.

**Contract validation scripts** (see "kagent integration" below):

```bash
bash scripts/kagent-template/test-contract.sh     # Layer 1: offline template render + assert
BACKSTAGE_URL=http://localhost:7007 bash scripts/check-agent-contract.sh   # Layer 3: live catalog
BACKSTAGE_URL=http://localhost:7007 bash scripts/check-cve-contract.sh    # Layer 3: CVE reports
```

**Build & deploy** — `./scripts/build-and-push.sh [--version vX.Y.Z] [--platform linux/amd64]`
does install → `yarn tsc` → `yarn build:all` → ECR login → `docker buildx` (cross-builds
amd64 from an arm64 Mac) → `kubectl rollout restart deployment/backstage -n backstage`.
Requires the `docker-buildx` CLI plugin.

> `yarn build:all`, not `yarn build:backend`. The backend image bundles the
> frontend's static assets from `packages/app/dist/`; building only the backend
> silently ships stale frontend JS. This has burned this repo before (commit `a7a25b0`).

## Architecture

### Monorepo layout

- `packages/app` — React frontend (`createApp`, `FlatRoutes`, Material UI **v4**)
- `packages/backend` — Node backend, New Backend System (`createBackend` + `backend.add(import(...))`)
- `plugins/` — empty; there are no local plugins yet. Custom backend code lives as
  **modules under `packages/backend/src/modules/`**, not as separate workspaces.
- `scripts/` — deploy + contract-validation shell/node scripts
- `docs/` — TechDocs source (`mkdocs.yml` at root) *and* design docs

Both `packages/backend/src/index.ts` and `packages/app/src/App.tsx` carry long
explanatory comments for every registered plugin. Read those first — they are the
de-facto architecture doc and are kept current.

### Custom backend modules

| Path | What it is |
|---|---|
| `modules/scaffolder/` | A single `createBackendModule({pluginId:'scaffolder', moduleId:'custom-actions'})` registering all custom actions via `scaffolderActionsExtensionPoint` |
| `modules/kagent-suggest/` | A `createBackendPlugin` exposing `POST /api/kagent-suggest/invoke` |
| `modules/kagent-shared/` | Library shared by the two above — `resolveAgent` / `invokeAgent` / `validateInvokeInput` / `tolerantParseJson` |
| `modules/cve/` | A `createBackendPlugin` exposing `POST /api/cve/report` and `GET /api/cve/health` — fetches the weekly Trivy scan report from S3, reduces it to actionable (CRITICAL/HIGH + fixed) findings, and joins it to a posted list of image references by repository path. See `docs/guides/container-cve-surfacing.md`. |

Custom scaffolder actions (all in `modules/scaffolder/`, each with a colocated
`.test.ts`): `publish:file`, `aws:ecr:create`, `aws:ecr:build-push`, `vault:setup`,
`crossplane:teardown:open-decommission-pr`, `kagent:agent:validate-name`,
`kagent:agent:open-decommission-pr`, `kagent:agent:invoke`, `newapp:validate-name`.

Actions that talk to GitHub read `process.env.GITHUB_TOKEN` directly and hardcode
`arigsela/kubernetes` as owner/repo. Tests mock `@octokit/rest` at the module level
and hand-roll a mock action context (see `newAppValidateNameAction.test.ts` for the
canonical shape).

### The kagent integration (the non-obvious part)

kagent Agents live as `kagent.dev/v1alpha2` CRDs in the `arigsela/kubernetes` repo
and get into the catalog via TeraSky's `kubernetes-ingestor`, which copies
`metadata.annotations` 1:1 onto a `kind: Component, spec.type: kagent-agent` entity.

**The `agents.platform.ai/*` v1 annotation contract is the seam** between the
cluster and everything in this repo. Seven required annotations: `version`
(must equal `"v1"`), `runtime`, `description`, `a2a-endpoint`, `skills` (JSON array),
`delegates` (JSON array), `capabilities` (JSON object). Full spec:
`docs/guides/agent-annotation-contract-v1.md`.

Consumers of the contract, all of which reject non-conformant entities:

- `kagent-shared/resolver.ts` — resolves an agent name → A2A endpoint by querying
  the *local* catalog API via `coreServices.discovery` (no second K8s hop)
- `kagent-shared/invoker.ts` — A2A JSON-RPC `message/send`. Wire format is pinned by
  live probing, not by a published schema: `params.message.messageId` is **required**
  (`-32602` otherwise), response text is at `.result.artifacts[].parts[].text`,
  and request parts use `type:"text"` while response parts use `kind:"text"`.
- `packages/app/src/components/catalog/EntityPage.tsx` — `isKagentAgent` switches
  agents onto a dedicated 3-tab layout and renders a Markdown summary fetched
  through the Kubernetes proxy (annotations alone were insufficient — the kagent
  controller drops some fields)
- `packages/app/src/scaffolder/KagentSuggestField/` — an rjsf field extension
  registered under `<ScaffolderFieldExtensions>` on the `/create` route. **The field
  IS the array it edits** (owns its value via `props.onChange`); an earlier design
  that wrote to a sibling field via `formContext.onChange` is impossible — Backstage's
  `formContext` exposes metadata only.

Two hard-won behaviors worth preserving: plugin-scoped routers need an explicit
`router.use(express.json())` (Backstage's global parser does not reach them —
commit `0c97027`), and LLM responses must go through `tolerantParseJson`, which
strips markdown fences and extracts JSON from surrounding prose (commit `6cb7f8e`).

### Catalog: where entities actually come from

Almost nothing is defined in this repo. Sources, all configured in `app-config.yaml`:

1. **`catalog.locations`** — self-registration (`catalog-info.yaml`), the platform
   taxonomy and API entities from `arigsela/kubernetes:catalog/*.yaml`, the
   New Application scaffolder template from `arigsela/kubernetes:templates/new-app/`,
   plus `examples/entities.yaml` + `examples/org.yaml`
2. **GitHub discovery providers** — `arigsela` scans repo-root `/catalog-info.yaml`
   across the org; `arigsela-kubernetes` separately scans
   `/base-apps/*/catalog-info.yaml` in the `kubernetes` repo only
3. **`kubernetesIngestor`** — annotated K8s workloads plus *all* Crossplane Claims;
   `ingestAllXRDs` auto-generates a scaffolder Template per XRD

`catalog.rules` globally allows only `[Component, System, API, Resource, Location]`.
Any location bringing in `Group`, `Domain`, `User`, or `Template` **must carry its own
per-location `rules: allow:`** or the entities are silently rejected. This is the
most common cause of "my entity didn't show up".

**Scaffolder templates no longer live in this repo** — they were moved to
`arigsela/kubernetes` (commit `c0bb285`). Consequence:
`scripts/kagent-template/render.js` still points at
`examples/templates/kagent-agent/...`, which no longer exists, so the Layer 1
contract harness cannot run as-is against this checkout.

### MCP actions

`@backstage/plugin-mcp-actions-backend` exposes a single read-only `catalog` server
at `/api/mcp-actions/v1/catalog`, consumed by the `homelab-knowledge` kagent agent.
Config gotcha: `namespacedToolNames: false` is deliberate — default names like
`catalog.get-catalog-entity` contain a dot, which violates Anthropic's tool-name
pattern and 400s the agent.

### Config layering

`app-config.yaml` (base, heavily commented) → `app-config.production.yaml`
(overrides, loaded second in the Dockerfile `CMD`) → `app-config.local.yaml`
(gitignored via `*.local.yaml`, and excluded from the image by `.dockerignore`).
Local dev is expected to hardcode the PG connection and switch Kubernetes auth to
`localKubectlProxy` in `app-config.local.yaml`. Env vars are documented in `.env.example`.
The `cve:` block (`bucket`, `region`, `prefix`, `cacheTtlMinutes`, `historyWeeks`) points
`modules/cve/` at the S3 bucket holding the weekly Trivy scan reports; it's a plain object
so the merge-objects-but-replace-arrays gotcha above doesn't apply to it.

## Conventions

- **Commits:** Conventional Commits with a scope — `feat(kagent):`, `fix(mcp):`,
  `docs(spec):`, `chore(deps):`. Branch per change, PR into `main`.
- **Design docs:** non-trivial features get a spec then a plan before code, under
  `docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md` and
  `docs/superpowers/plans/YYYY-MM-DD-<slug>.md`. Plans use `- [ ]` task checkboxes
  and are amended in place with validation results and discovered gotchas rather
  than rewritten. Stable, user-facing docs graduate to `docs/guides/`.
- **Validation layers:** the repo talks about Layer 1 (offline/unit), Layer 2
  (manual against the live cluster), Layer 3 (automated against the live catalog).
  Layer 2 outcomes get recorded back into the plan document.
- **Comment style:** this codebase is unusually heavily commented, explaining *why*
  and teaching Backstage concepts inline. Match that density in `app-config.yaml`,
  `index.ts`, and `App.tsx`; ordinary density elsewhere.

## Known stale spots

- `docs/index.md` claims Backstage 1.48 and `yarn dev`; the real values are
  `backstage.json` → 1.52.0 and `yarn start`.
- `scripts/kagent-template/render.js` — see "Catalog" above.
- `packages/backend/Dockerfile` header says to run `yarn build:backend`; use
  `yarn build:all` for the reason given under "Build & deploy".
