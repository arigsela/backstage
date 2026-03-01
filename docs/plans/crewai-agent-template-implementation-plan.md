# CrewAI Agent Backstage Template - Implementation Plan

**Created:** 2026-03-01
**Last Updated:** 2026-03-01
**Current Status:** Phase 2 Complete — Templatized Agent Code
**Overall Progress:** 11/28 tasks (39%)

---

## Overview

Create a reusable Backstage Software Template that enables self-service deployment of new CrewAI multi-agent projects through the Backstage UI. The template scaffolds a complete agent project (orchestrator + configurable sub-agents) with full Kubernetes deployment manifests, following the patterns established by the existing `oncall-crewai` project.

**First Use Case:** A "Chores Tracker Knowledge Agent" with an orchestrator and one knowledge sub-agent that provides RAG-powered answers about the chores-tracker application (API docs, deployment info, troubleshooting).

## Success Criteria

- [ ] Template appears in Backstage `/create` page and executes successfully
- [ ] Scaffolded project follows oncall-crewai architecture (A2A protocol, CrewAI agents, FastAPI)
- [ ] K8s manifests match existing GitOps patterns (ArgoCD, Vault, ECR, cert-manager)
- [ ] Chores-tracker knowledge agent deployed and answering domain questions
- [ ] Template is reusable for future agent projects with different sub-agents
- [ ] All generated code is heavily commented for learning purposes

## Research Findings

### Reference Architecture: oncall-crewai

The oncall-crewai project is a 4-service multi-agent system:
- **Orchestrator** (port 8000): FastAPI + CrewAI Flow, keyword-based routing, JWT auth, session management
- **K8s Agent** (port 8080): CrewAI agent with 7 K8s diagnostic tools, A2A protocol
- **GitHub Agent** (port 8080): CrewAI agent with 5 GitOps tools, A2A protocol
- **Frontend** (port 3000): Next.js + CopilotKit chat UI

Key patterns to templatize:
- `src/shared/` — config, logging, models, observability (reusable across all agents)
- `src/orchestrator/` — FastAPI app, CrewAI Flow router, A2A delegate agents
- `src/{agent}/` — FastAPI server, CrewAI agent, A2A executor, tools, YAML configs
- `k8s/` — per-service deployments, configmaps, Vault secrets, ArgoCD app
- `docker/` — per-service Dockerfiles (python:3.11-slim base)

### Existing Backstage Template Pattern

Located at `examples/template/template.yaml`:
- Uses `scaffolder.backstage.io/v1beta3` API
- Parameters define multi-step wizard forms (JSON Schema + `ui:*` extensions)
- Steps: `fetch:template` → `publish:github` → `catalog:register` → `notification:send`
- Content files use Nunjucks templating (`${{ values.name }}`)
- `publish:github` action requires `scaffolder-backend-module-github` (already registered)

### K8s Deployment Patterns (arigsela/kubernetes)

From `base-apps/oncall-crewai/`:
- ArgoCD auto-sync with `prune: true`, `selfHeal: true`, `CreateNamespace=true`
- Vault SecretStore per namespace at `http://vault.vault.svc.cluster.local:8200`
- ExternalSecrets for `anthropic-api-key`, `api-keys`, service-specific secrets
- ECR images: `852893458518.dkr.ecr.us-east-2.amazonaws.com/<image>:<tag>`
- Nginx ingress with cert-manager `letsencrypt-prod`, IP whitelist, long AI timeouts
- Resources: 256Mi/250m requests, 512Mi/500m limits

### Key Technical Risks

1. **Nunjucks vs Python conflicts**: Backstage templates use `${{ }}` syntax. Python f-strings and Jinja2 templates in CrewAI YAML configs use `{ }`. Must use Nunjucks `{% raw %}` blocks to avoid conflicts.
2. **CrewAI knowledge sources**: Require embeddings provider config. Need to verify setup with latest CrewAI 1.6.x docs.
3. **GitHub token permissions**: `publish:github` needs the `GITHUB_TOKEN` integration to have repo creation permissions in the `arigsela` org.

## Architecture Decisions

### Decision 1: Single Template vs Multiple Templates
**Options:** (A) One template creates agent code repo + K8s deployment PR (B) One template creates agent code repo, separate template for K8s deploy (C) One template creates repo with K8s manifests included as reference
**Chosen:** Option C — The template creates a single GitHub repo containing both the agent code AND a `k8s/` directory with ready-to-use manifests. The user copies these to the `arigsela/kubernetes` repo (or we add a `publish:github:pull-request` step later). This matches how oncall-crewai is structured and avoids complex multi-repo orchestration in the template.

### Decision 2: Agent Communication Protocol
**Options:** (A) Direct HTTP calls (B) Google A2A protocol (C) CrewAI native delegation
**Chosen:** Option B — A2A protocol, matching oncall-crewai. Each sub-agent is independently deployable with `/.well-known/agent.json` discovery. This is the most flexible and production-ready approach.

### Decision 3: Knowledge/RAG Architecture
**Options:** (A) CrewAI built-in knowledge sources (B) External vector DB (Chroma/Pinecone) (C) Simple file-based context injection
**Chosen:** Option A — CrewAI's built-in knowledge system (`TextFileKnowledgeSource`, `JSONKnowledgeSource`). It handles embeddings internally, requires no external infrastructure, and is sufficient for domain-specific knowledge. Can upgrade to Option B later if scale demands it.

### Decision 4: Frontend Inclusion
**Options:** (A) Include CopilotKit frontend in template (B) No frontend, API-only (C) Optional frontend parameter
**Chosen:** Option B for the initial template — API-only (orchestrator + sub-agents). The oncall-crewai frontend is tightly coupled to that project's UX. Future enhancement can add a generic chat frontend option. Users can integrate with the existing oncall-crewai frontend or build their own.

---

## Implementation

### Phase 1: Template Skeleton & Registration (4 tasks)

#### Task 1.1: Create Template Directory Structure
**Status:** ✅ Complete
**Files:**
- `examples/templates/crewai-agent/template.yaml` (new)
- `examples/templates/crewai-agent/content/` (new directory)

Create the template directory under `examples/templates/` and define the `template.yaml` with the entity header:
```yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: crewai-agent-template
  title: CrewAI Multi-Agent Project
  description: Scaffold a new CrewAI multi-agent project with orchestrator and sub-agents
  tags: [crewai, ai-agent, python, a2a]
spec:
  owner: group:platform-engineering
  type: service
```

#### Task 1.2: Define Template Parameters (Wizard Steps)
**Status:** ✅ Complete
**Files:** `examples/templates/crewai-agent/template.yaml`

Define 4 wizard steps in `spec.parameters`:

**Step 1 — Project Details:**
- `name` (string, required): Project name (e.g., `chores-knowledge-agent`)
- `description` (string, required): What the agent does
- `owner` (EntityPicker, required): Backstage group/user owner

**Step 2 — Orchestrator Config:**
- `orchestratorPort` (number, default 8000)
- `routingKeywords` (string): Comma-separated routing keywords

**Step 3 — Sub-Agent Config:**
- `subAgentName` (string, required): e.g., `knowledge-agent`
- `subAgentDisplayName` (string): e.g., `Knowledge Specialist`
- `subAgentRole` (string): CrewAI role description
- `subAgentGoal` (string): CrewAI goal description
- `subAgentPort` (number, default 8080)
- `enableKnowledge` (boolean, default true): Include CrewAI knowledge/RAG

**Step 4 — Infrastructure:**
- `repoUrl` (RepoUrlPicker, required): GitHub repo to create
- `domain` (string): Ingress subdomain (e.g., `chores-agent.arigsela.com`)
- `vaultRole` (string, default from project name): Vault role name

#### Task 1.3: Register Template in Backstage Catalog
**Status:** ✅ Complete
**Files:** `app-config.yaml`

Add a new catalog location entry:
```yaml
catalog:
  locations:
    - type: file
      target: ../../examples/templates/crewai-agent/template.yaml
      rules:
        - allow: [Template]
```

#### Task 1.4: Verify Template Appears in UI
**Status:** ✅ Complete (merged with Task 1.1 — template has steps + outputs + publish:file for testing)

Start Backstage locally (`yarn start`), navigate to `/create`, and verify the "CrewAI Multi-Agent Project" template appears with all parameter steps rendering correctly.

**Phase 1 Summary:** Template skeleton created at `examples/templates/crewai-agent/template.yaml` with 4-step wizard (Project Details, Orchestrator Config, Sub-Agent Config, Infrastructure). Registered in both `app-config.yaml` and `app-config.production.yaml`. Uses `publish:file` for local testing with commented `publish:github` block ready for production. Placeholder `content/` directory has `catalog-info.yaml` and `README.md` with Nunjucks templating.

---

### Phase 2: Templatized Agent Code (7 tasks)

All files go in `examples/templates/crewai-agent/content/` and use Nunjucks templating (`${{ values.* }}`).

#### Task 2.1: Shared Utilities (`src/shared/`)
**Status:** ✅ Complete
**Files (in content/):**
- `src/shared/__init__.py`
- `src/shared/config.py` — env var constants, model config
- `src/shared/logging_config.py` — text/JSON logging setup
- `src/shared/models.py` — Pydantic output models + guardrails
- `src/shared/observability.py` — step/task callbacks, timing, token logging

Based on oncall-crewai `src/shared/` but with templatized project name and model config. These are largely copy-paste with comments added explaining each piece.

#### Task 2.2: Orchestrator Code (`src/orchestrator/`)
**Status:** ✅ Complete
**Files (in content/):**
- `src/orchestrator/__init__.py`
- `src/orchestrator/main.py` — FastAPI app with health, invoke, auth endpoints
- `src/orchestrator/flow.py` — CrewAI Flow: classify → route → handle sub-agent
- `src/orchestrator/agents.py` — A2A delegate agent factory (templatized sub-agent URL)
- `src/orchestrator/prompts.py` — Routing keywords (from `${{ values.routingKeywords }}`)

Simplified from oncall-crewai: single sub-agent routing (no combined routing needed), no CopilotKit integration, no session persistence (simpler starting point).

#### Task 2.3: Sub-Agent Code (`src/${{ values.subAgentName }}/`)
**Status:** ✅ Complete
**Files (in content/):**
- `src/${{ values.subAgentName }}/__init__.py`
- `src/${{ values.subAgentName }}/server.py` — FastAPI + A2A mount, API key auth middleware
- `src/${{ values.subAgentName }}/agent.py` — `create_agent()` + `invoke()` with CrewAI
- `src/${{ values.subAgentName }}/executor.py` — A2A→CrewAI bridge (TaskState events)
- `src/${{ values.subAgentName }}/tools.py` — Placeholder tools (query_knowledge, search_docs)
- `src/${{ values.subAgentName }}/prompts.py` — Role/goal/backstory from template params
- `src/${{ values.subAgentName }}/config/agents.yaml` — Agent identity YAML
- `src/${{ values.subAgentName }}/config/tasks.yaml` — Task template YAML

The agent code will conditionally include CrewAI knowledge source setup if `${{ values.enableKnowledge }}` is true (using Nunjucks `{% if %}` blocks).

**Important:** Python code with `{ }` (dicts, f-strings, sets) must be wrapped in `{% raw %}...{% endraw %}` Nunjucks blocks to prevent template engine conflicts.

#### Task 2.4: Root Project Files
**Status:** ✅ Complete
**Files (in content/):**
- `README.md` — Project overview, setup instructions, architecture diagram
- `pyproject.toml` — Build config with CrewAI, FastAPI, A2A dependencies
- `requirements.txt` — Pinned dependencies (based on oncall-crewai's working set)
- `.env.example` — All env vars documented with descriptions
- `.gitignore` — Python + Node + IDE ignores
- `catalog-info.yaml` — Backstage entity with kubernetes-id annotation

#### Task 2.5: Docker Configuration
**Status:** ✅ Complete
**Files (in content/):**
- `docker/Dockerfile.orchestrator` — python:3.11-slim, port `${{ values.orchestratorPort }}`
- `docker/Dockerfile.${{ values.subAgentName }}` — python:3.11-slim, port `${{ values.subAgentPort }}`
- `docker-compose.yml` — Both services + shared network
- `deploy-to-ecr.sh` — ECR build/push script for all images

#### Task 2.6: Test Scaffolding
**Status:** ✅ Complete
**Files (in content/):**
- `tests/__init__.py`
- `tests/conftest.py` — Singleton reset fixtures
- `tests/test_orchestrator.py` — Basic routing + endpoint tests
- `tests/test_${{ values.subAgentName }}.py` — Agent creation, tools, A2A protocol tests

Provide ~10 skeleton tests that pass out of the box with the scaffolded code.

#### Task 2.7: Knowledge Configuration (conditional)
**Status:** ✅ Complete
**Files (in content/):**
- `config/knowledge/README.md` — How to add knowledge sources
- `config/knowledge/.gitkeep` — Placeholder for knowledge files

Only included when `enableKnowledge` is true. The README explains how to add `.txt`, `.json`, `.csv`, or `.pdf` files that the agent will use for RAG.

**Phase 2 Summary:** All 7 tasks complete. Created 25+ templatized files in `content/`:
- `src/shared/` — config, logging (text/JSON), Pydantic models with guardrails, observability callbacks
- `src/orchestrator/` — FastAPI app, CrewAI Flow (classify→route→delegate), A2A delegate agent factory, keyword routing
- `src/${{ values.subAgentName }}/` — FastAPI+A2A server, CrewAI agent with 3 placeholder tools, executor bridge, YAML configs
- Root files: pyproject.toml, requirements.txt, .env.example, .gitignore, catalog-info.yaml, README.md
- Docker: Dockerfiles for orchestrator + sub-agent, docker-compose.yml, deploy-to-ecr.sh
- Tests: conftest.py, test_orchestrator.py (6 tests), test_sub_agent.py (8 tests)
- Knowledge: config/knowledge/ with README and .gitkeep
All Python code wrapped in `{% raw %}...{% endraw %}` Nunjucks blocks to prevent template engine conflicts.

---

### Phase 3: Templatized K8s Manifests (5 tasks)

All files go in `examples/templates/crewai-agent/content/k8s/`.

#### Task 3.1: Namespace & ArgoCD Application
**Status:** ⬜ Pending
**Files (in content/):**
- `k8s/namespace.yaml` — Namespace with team label
- `k8s/argocd-app.yaml` — ArgoCD Application manifest (source: `base-apps/${{ values.name }}/`, auto-sync, CreateNamespace)

The ArgoCD app manifest is included as a reference — the user copies it to `base-apps/${{ values.name }}.yaml` in the kubernetes repo.

#### Task 3.2: Vault Secrets & External Secrets
**Status:** ⬜ Pending
**Files (in content/):**
- `k8s/secret-store.yaml` — SecretStore for Vault (`role: ${{ values.vaultRole }}`)
- `k8s/external-secret.yaml` — ExternalSecrets for orchestrator + sub-agent (anthropic-api-key, api-keys)

#### Task 3.3: Orchestrator K8s Manifests
**Status:** ⬜ Pending
**Files (in content/):**
- `k8s/orchestrator/deployment.yaml` — Deployment + ServiceAccount + Service
- `k8s/orchestrator/configmap.yaml` — Internal service URLs, CORS config
- `k8s/orchestrator/pvc.yaml` — 1Gi PVC for data persistence

Follows oncall-crewai pattern: ECR image, secretKeyRef for sensitive env vars, envFrom for configmap, health checks on `/health`.

#### Task 3.4: Sub-Agent K8s Manifests
**Status:** ⬜ Pending
**Files (in content/):**
- `k8s/${{ values.subAgentName }}/deployment.yaml` — Deployment + Service
- `k8s/${{ values.subAgentName }}/configmap.yaml` — Agent URL, port config

#### Task 3.5: Ingress & Networking
**Status:** ⬜ Pending
**Files (in content/):**
- `k8s/ingress.yaml` — Nginx ingress with TLS (cert-manager), IP whitelist, AI-appropriate timeouts (300s)

Only generated if `${{ values.domain }}` is provided. Uses `cert-manager.io/cluster-issuer: letsencrypt-prod`.

---

### Phase 4: Template Actions & Integration (4 tasks)

#### Task 4.1: Wire Template Steps
**Status:** ⬜ Pending
**Files:** `examples/templates/crewai-agent/template.yaml`

Add the execution steps to `spec.steps`:
```yaml
steps:
  - id: fetch-base
    name: Fetch Agent Project Skeleton
    action: fetch:template
    input:
      url: ./content
      values:
        name: ${{ parameters.name }}
        description: ${{ parameters.description }}
        owner: ${{ parameters.owner }}
        orchestratorPort: ${{ parameters.orchestratorPort }}
        routingKeywords: ${{ parameters.routingKeywords }}
        subAgentName: ${{ parameters.subAgentName }}
        subAgentDisplayName: ${{ parameters.subAgentDisplayName }}
        subAgentRole: ${{ parameters.subAgentRole }}
        subAgentGoal: ${{ parameters.subAgentGoal }}
        subAgentPort: ${{ parameters.subAgentPort }}
        enableKnowledge: ${{ parameters.enableKnowledge }}
        domain: ${{ parameters.domain }}
        vaultRole: ${{ parameters.vaultRole }}

  - id: publish
    name: Create GitHub Repository
    action: publish:github
    input:
      repoUrl: ${{ parameters.repoUrl }}
      description: ${{ parameters.description }}
      defaultBranch: main
      repoVisibility: private

  - id: register
    name: Register in Backstage Catalog
    action: catalog:register
    input:
      repoContentsUrl: ${{ steps['publish'].output.repoContentsUrl }}
      catalogInfoPath: /catalog-info.yaml

  - id: notify
    name: Notify Creator
    action: notification:send
    input:
      recipients: entity
      entityRefs:
        - ${{ parameters.owner }}
      title: 'CrewAI Agent "${{ parameters.name }}" created'
      info: 'Your agent project has been scaffolded. Check the repo README for next steps.'
      severity: normal
```

#### Task 4.2: Define Template Outputs
**Status:** ⬜ Pending
**Files:** `examples/templates/crewai-agent/template.yaml`

```yaml
output:
  links:
    - title: Repository
      url: ${{ steps['publish'].output.remoteUrl }}
    - title: Open in Catalog
      icon: catalog
      entityRef: ${{ steps['register'].output.entityRef }}
```

#### Task 4.3: Test Template Execution (Local)
**Status:** ⬜ Pending

Run Backstage locally, execute the template with test parameters, verify:
1. GitHub repo created with all expected files
2. Nunjucks templating resolved correctly (no `${{ }}` remnants)
3. Python code is syntactically valid (no broken f-strings/dicts from template conflicts)
4. catalog-info.yaml registered and entity appears in catalog
5. K8s manifests have correct values substituted

#### Task 4.4: Fix Nunjucks/Python Template Conflicts
**Status:** ⬜ Pending

Review all Python files in `content/` for `{ }` characters that conflict with Nunjucks. Wrap Python code blocks containing dicts, sets, f-strings, and format strings in `{% raw %}...{% endraw %}` blocks. This is the most error-prone part of the implementation and likely requires iteration.

---

### Phase 5: First Use Case — Chores Tracker Knowledge Agent (5 tasks)

#### Task 5.1: Execute Template for Chores Tracker
**Status:** ⬜ Pending

Run the template from Backstage UI with these parameters:
- **name:** `chores-knowledge-agent`
- **description:** "AI agent with deep knowledge of the Chores Tracker application"
- **owner:** `group:platform-engineering`
- **orchestratorPort:** 8000
- **routingKeywords:** "chores, tasks, assignments, household, todo, schedule, family, members"
- **subAgentName:** `knowledge-agent`
- **subAgentDisplayName:** "Chores Tracker Knowledge Specialist"
- **subAgentRole:** "Chores Tracker Application Expert"
- **subAgentGoal:** "Answer questions about the Chores Tracker app architecture, API, deployment, and troubleshooting"
- **subAgentPort:** 8080
- **enableKnowledge:** true
- **domain:** `chores-agent.arigsela.com`
- **vaultRole:** `chores-knowledge-agent`

#### Task 5.2: Populate Knowledge Sources
**Status:** ⬜ Pending
**Files (in new repo):** `config/knowledge/`

Create knowledge source files:
- `api-docs.json` — Chores Tracker API endpoints, request/response schemas
- `architecture.txt` — System architecture: FastAPI backend, MySQL DB, HTMX frontend, K8s deployment
- `deployment-guide.txt` — How chores-tracker is deployed (ArgoCD, ECR, Vault secrets)
- `troubleshooting.txt` — Common issues, health check endpoints, dependency chain
- `data-model.txt` — Database schema, entity relationships

#### Task 5.3: Implement Domain-Specific Tools
**Status:** ⬜ Pending
**Files (in new repo):** `src/knowledge-agent/tools.py`

Replace placeholder tools with chores-tracker specific tools:
- `query_knowledge(question: str)` — RAG query against knowledge files
- `get_api_endpoint_info(endpoint_path: str)` — Look up API endpoint details
- `get_deployment_status()` — Check chores-tracker K8s deployment health (optional, could call K8s API)
- `search_troubleshooting(issue: str)` — Search troubleshooting runbooks

#### Task 5.4: Deploy to Kubernetes
**Status:** ⬜ Pending

1. Build Docker images and push to ECR
2. Create Vault secrets (`chores-knowledge-agent` path)
3. Copy K8s manifests from `k8s/` to `base-apps/chores-knowledge-agent/` in kubernetes repo
4. Copy ArgoCD app manifest to `base-apps/chores-knowledge-agent.yaml`
5. Commit and push — ArgoCD auto-deploys

#### Task 5.5: Verify End-to-End
**Status:** ⬜ Pending

1. Confirm pods are running in `chores-knowledge-agent` namespace
2. Test orchestrator health endpoint
3. Send test queries via API:
   - "What API endpoints does chores-tracker have?"
   - "How is chores-tracker deployed?"
   - "The chores-tracker backend is returning 500 errors, what should I check?"
4. Verify knowledge RAG is returning relevant context
5. Confirm entity appears in Backstage catalog with Kubernetes tab

---

### Phase 6: Documentation & Refinement (3 tasks)

#### Task 6.1: Template Usage Guide
**Status:** ⬜ Pending
**Files:** `docs/guides/crewai-agent-template-guide.md` (in backstage repo)

Document:
- How to use the template from Backstage UI
- What each parameter means
- What gets created (repo structure walkthrough)
- How to deploy the generated project to K8s

#### Task 6.2: Extension Guide
**Status:** ⬜ Pending
**Files:** included in generated repo's `README.md`

Document how to:
- Add a new sub-agent to an existing project
- Add new tools to a sub-agent
- Add/modify knowledge sources
- Configure custom routing keywords
- Connect to the oncall-crewai frontend

#### Task 6.3: Update Backstage Implementation Plan
**Status:** ⬜ Pending
**Files:** `docs/plans/backstage-deployment-implementation-plan.md`

Add Phase 8 (or extend Phase 7) to the main Backstage plan tracking the template work.

---

## Technical Notes

### Nunjucks Template Escaping

Python code with curly braces MUST be escaped. Example:

```python
# In template content file:
{% raw %}
def get_config():
    return {"key": "value", "port": 8080}
{% endraw %}

# But template values work outside raw blocks:
PROJECT_NAME = "${{ values.name }}"
```

### CrewAI Knowledge Setup

```python
from crewai import Agent, Crew, Knowledge
from crewai.knowledge.source.text_file_knowledge_source import TextFileKnowledgeSource

knowledge = Knowledge(
    sources=[
        TextFileKnowledgeSource(file_paths=["config/knowledge/api-docs.json"]),
        TextFileKnowledgeSource(file_paths=["config/knowledge/architecture.txt"]),
    ],
    embedder_config={
        "provider": "anthropic",  # or "openai" depending on availability
    }
)

agent = Agent(
    role="Knowledge Specialist",
    knowledge=knowledge,
    # ...
)
```

### ECR Image Naming Convention

Following oncall-crewai pattern:
- Orchestrator: `852893458518.dkr.ecr.us-east-2.amazonaws.com/${{ values.name }}-orchestrator`
- Sub-agent: `852893458518.dkr.ecr.us-east-2.amazonaws.com/${{ values.name }}-${{ values.subAgentName }}`

### Vault Secret Path Convention

All secrets under: `k8s-secrets/data/${{ values.vaultRole }}`
Required keys:
- `anthropic-api-key` — for CrewAI LLM calls
- `api-keys` — for inter-service A2A authentication

---

## Progress Tracking

| Phase | Status | Tasks | Completion |
|-------|--------|-------|------------|
| Phase 1: Template Skeleton | ✅ Complete | 4/4 | 100% |
| Phase 2: Agent Code Templates | ✅ Complete | 7/7 | 100% |
| Phase 3: K8s Manifest Templates | ⬜ Not Started | 0/5 | 0% |
| Phase 4: Template Actions | ⬜ Not Started | 0/4 | 0% |
| Phase 5: Chores Tracker Agent | ⬜ Not Started | 0/5 | 0% |
| Phase 6: Documentation | ⬜ Not Started | 0/3 | 0% |
| **Total** | | **11/28** | **39%** |
