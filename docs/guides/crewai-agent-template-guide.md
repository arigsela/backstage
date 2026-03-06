# CrewAI Agent Template — Usage Guide

This guide walks you through using the **CrewAI Multi-Agent Project** Backstage
Software Template to scaffold a new AI agent project with an orchestrator and
sub-agents.

## Prerequisites

Before using the template, ensure:
1. Backstage is running locally (`yarn start`) or in production
2. You have access to the `/create` page in Backstage
3. A GitHub organization is configured (default: `arigsela`)
4. For production deployment: Vault, ECR, and ArgoCD are configured

## Using the Template

### Step 1: Navigate to the Template

1. Open Backstage at `http://localhost:3000` (or your production URL)
2. Click **"Create..."** in the left sidebar (or navigate to `/create`)
3. Find **"CrewAI Multi-Agent Project"** in the template list
4. Click **"Choose"**

### Step 2: Fill in the Wizard

The template has 4 pages:

#### Page 1 — Project Details
| Field | Description | Example |
|-------|-------------|---------|
| **Project Name** | Lowercase, hyphens only. Becomes the repo name, K8s namespace, and Backstage entity. | `chores-knowledge-agent` |
| **Description** | What the agent does. Shown in catalog and repo. | "AI agent with deep knowledge of the Chores Tracker app" |
| **Owner** | Backstage group/user that owns this agent. | `group:platform-engineering` |

#### Page 2 — Orchestrator Configuration
| Field | Description | Default |
|-------|-------------|---------|
| **Orchestrator Port** | FastAPI server port. | `8000` |
| **Routing Keywords** | Comma-separated keywords for query classification. The orchestrator uses keyword matching (not LLM) for fast, deterministic routing. | `chores, tasks, assignments` |

#### Page 3 — Sub-Agent Configuration
| Field | Description | Example |
|-------|-------------|---------|
| **Sub-Agent Name** | Short name (lowercase, hyphens). Used for module, Docker image, K8s service. | `knowledge-agent` |
| **Display Name** | Human-readable name for logs and A2A discovery. | "Chores Tracker Knowledge Specialist" |
| **CrewAI Role** | The agent's "job title" — shapes behavior. | "Chores Tracker Application Expert" |
| **CrewAI Goal** | What the agent tries to achieve. | "Answer questions about architecture, API, deployment..." |
| **Sub-Agent Port** | FastAPI server port. | `8080` |
| **Enable Knowledge/RAG** | Adds `config/knowledge/` directory for RAG files. | `true` |

#### Page 4 — Infrastructure
| Field | Description | Example |
|-------|-------------|---------|
| **Repository Location** | GitHub org/repo to create. | `github.com/arigsela/chores-knowledge-agent` |
| **Ingress Domain** | Optional. Creates nginx ingress with TLS. | `chores-agent.arigsela.com` |
| **Vault Role** | Vault role name for K8s auth. Defaults to project name. | `chores-knowledge-agent` |

### Step 3: Review and Create

Click **"Create"** to execute the template. In testing mode (`publish:file`),
the output is written to `/tmp/backstage-scaffolder/<project-name>/`.

## What Gets Created

The template generates a complete project with this structure:

```
<project-name>/
├── catalog-info.yaml          # Backstage entity (auto-registered)
├── README.md                  # Project docs with architecture diagram
├── pyproject.toml             # Python build config
├── requirements.txt           # Pinned dependencies
├── .env.example               # Environment variables reference
├── .gitignore
│
├── src/
│   ├── shared/                # Reusable utilities
│   │   ├── config.py          # Environment configuration
│   │   ├── logging_config.py  # JSON/text logging
│   │   ├── models.py          # Pydantic output models
│   │   └── observability.py   # Metrics and callbacks
│   │
│   ├── orchestrator/          # Entry point service
│   │   ├── main.py            # FastAPI app (/health, /invoke, /info)
│   │   ├── flow.py            # CrewAI Flow (classify -> route -> delegate)
│   │   ├── agents.py          # A2A delegate agent factory
│   │   └── prompts.py         # Routing keywords and templates
│   │
│   └── <sub-agent>/           # Domain-specific agent
│       ├── server.py          # FastAPI + A2A protocol server
│       ├── agent.py           # CrewAI agent with tools
│       ├── executor.py        # A2A → CrewAI bridge
│       ├── tools.py           # Placeholder tools (customize these!)
│       ├── prompts.py         # Role, goal, backstory
│       └── config/            # YAML agent/task configs
│
├── tests/                     # pytest test suite (14 tests)
├── config/knowledge/          # RAG knowledge files (if enabled)
│
├── docker/                    # Per-service Dockerfiles
├── docker-compose.yml         # Local development
├── deploy-to-ecr.sh           # ECR build/push script
│
└── k8s/                       # Kubernetes manifests
    ├── namespace.yaml
    ├── argocd-app.yaml        # Copy to kubernetes repo
    ├── secret-store.yaml      # Vault integration
    ├── external-secret.yaml   # Secrets for both services
    ├── ingress.yaml           # Nginx + TLS (if domain provided)
    ├── orchestrator/          # Deployment, ConfigMap, PVC
    └── <sub-agent>/           # Deployment, ConfigMap
```

## Post-Generation Steps

### 1. Customize Tools
Edit `src/<sub-agent>/tools.py` to replace placeholder tools with your
domain-specific tools. See `examples/chores-tracker-knowledge/tools.py`
for a real example.

### 2. Add Knowledge Files (if RAG enabled)
Place `.txt`, `.json`, `.csv`, or `.pdf` files in `config/knowledge/`.
See `examples/chores-tracker-knowledge/` for examples.

### 3. Local Development
```bash
# Set environment variables
cp .env.example .env
# Edit .env with your Anthropic API key and other secrets

# Run with Docker Compose
docker-compose up --build

# Or run directly (for development)
pip install -r requirements.txt
uvicorn orchestrator.main:app --host 0.0.0.0 --port 8000
```

### 4. Run Tests
```bash
pip install -r requirements.txt
pytest tests/ -v
```

### 5. Deploy to Kubernetes
```bash
# 1. Create ECR repositories
aws ecr create-repository --repository-name <project>-orchestrator
aws ecr create-repository --repository-name <project>-<sub-agent>

# 2. Build and push images
chmod +x deploy-to-ecr.sh
./deploy-to-ecr.sh --version v1.0.0

# 3. Create Vault secrets
vault kv put k8s-secrets/<vault-role> \
  anthropic-api-key="sk-ant-..." \
  api-keys="key1,key2"

# 4. Create Vault role
vault write auth/kubernetes/role/<vault-role> \
  bound_service_account_names=default \
  bound_service_account_namespaces=<project-name> \
  policies=k8s-secrets-read \
  ttl=1h

# 5. Copy K8s manifests to kubernetes repo
cp k8s/argocd-app.yaml /path/to/kubernetes/base-apps/<project-name>.yaml
cp -r k8s/namespace.yaml k8s/secret-store.yaml k8s/external-secret.yaml \
  k8s/ingress.yaml k8s/orchestrator/ k8s/<sub-agent>/ \
  /path/to/kubernetes/base-apps/<project-name>/

# 6. Commit and push — ArgoCD auto-deploys
cd /path/to/kubernetes
git add . && git commit -m "Deploy <project-name>" && git push
```

### 6. Create DNS Record
If you provided a domain, create an A record or CNAME pointing to your
cluster's ingress controller external IP.

## Switching to Production Mode

The template ships with `publish:file` for local testing. To enable
GitHub repo creation:

1. Open `examples/templates/crewai-agent/template.yaml`
2. Comment out the `publish:file` step
3. Uncomment the `publish:github` block
4. Uncomment the `catalog:register` and `notification:send` steps
5. Uncomment the production output links
6. Restart Backstage

## Adding More Sub-Agents

The template creates one sub-agent. To add more:

1. Copy `src/<existing-sub-agent>/` to `src/<new-agent>/`
2. Update the new agent's `prompts.py` with its role/goal/backstory
3. Customize `tools.py` for the new domain
4. Add a new Dockerfile in `docker/`
5. Add the new service to `docker-compose.yml`
6. Update `src/orchestrator/flow.py` to route to the new agent
7. Add K8s manifests for the new agent in `k8s/<new-agent>/`
8. Add an ExternalSecret for the new agent in `k8s/external-secret.yaml`
