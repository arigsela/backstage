# ${{ values.name }}

${{ values.description }}

## Architecture

This is a CrewAI multi-agent project with:

- **Orchestrator** (port ${{ values.orchestratorPort }}): Routes queries to sub-agents via A2A protocol
- **${{ values.subAgentDisplayName }}** (port ${{ values.subAgentPort }}): ${{ values.subAgentGoal }}

## Quick Start

### Prerequisites

- Python 3.11+
- Docker & Docker Compose
- An Anthropic API key (`ANTHROPIC_API_KEY`)

### Local Development

```bash
# 1. Copy environment file and fill in your values
cp .env.example .env

# 2. Start services with Docker Compose
docker-compose up --build

# 3. Test the orchestrator health endpoint
curl http://localhost:${{ values.orchestratorPort }}/health

# 4. Send a test query
curl -X POST http://localhost:${{ values.orchestratorPort }}/invoke \
  -H "Content-Type: application/json" \
  -d '{"query": "Hello, what can you help me with?"}'
```

### Running Tests

```bash
pip install -r requirements.txt
pytest tests/ -v
```

## Deployment

### Build & Push Images

```bash
# Build and push to ECR (requires AWS credentials)
./deploy-to-ecr.sh --version 1.0.0
```

### Kubernetes Deployment

K8s manifests are in the `k8s/` directory. To deploy:

1. Copy `k8s/argocd-app.yaml` to `base-apps/${{ values.name }}.yaml` in the kubernetes repo
2. Copy `k8s/` contents (except argocd-app.yaml) to `base-apps/${{ values.name }}/` in the kubernetes repo
3. Configure Vault secrets at path `k8s-secrets/data/${{ values.vaultRole }}`
4. Commit and push — ArgoCD will auto-deploy

### Required Vault Secrets

| Key | Description |
|-----|-------------|
| `anthropic-api-key` | Anthropic API key for CrewAI LLM calls |
| `api-keys` | Comma-separated API keys for inter-service A2A auth |

## Customizing Your Agent

### Adding Knowledge Sources (RAG)

Place files in `config/knowledge/` to give your agent domain-specific context:

- `.txt` files for architecture docs, runbooks, and guides
- `.json` files for API specs and structured data
- `.csv` files for tabular data (service catalogs, metrics)
- `.pdf` files for design docs and RFCs

Then update `src/${{ values.subAgentName }}/tools.py` to read from these files.
Rebuild with `docker-compose up --build` to include the new knowledge.

### Customizing Tools

Edit `src/${{ values.subAgentName }}/tools.py` to add domain-specific tools.
Each tool is a Python function decorated with `@tool` from CrewAI:

```python
from crewai.tools import tool

@tool("my_custom_tool")
def my_custom_tool(query: str) -> str:
    """Description of what this tool does."""
    # Your implementation here
    return json.dumps({"result": "..."})
```

### Modifying Routing Keywords

Edit `src/orchestrator/prompts.py` or update the `ROUTING_KEYWORDS` environment
variable to change which queries route to your sub-agent.

## Adding More Sub-Agents

1. Create a new directory under `src/` following the pattern of `src/${{ values.subAgentName }}/`
2. Add a Dockerfile in `docker/`
3. Add K8s manifests in `k8s/`
4. Update the orchestrator's routing keywords and agent factories in `src/orchestrator/`

## Project Structure

```
${{ values.name }}/
├── src/
│   ├── shared/          # Common utilities (config, logging, models)
│   ├── orchestrator/    # Query router + A2A delegation
│   └── ${{ values.subAgentName }}/  # Sub-agent with tools and knowledge
├── k8s/                 # Kubernetes deployment manifests
├── docker/              # Dockerfiles per service
├── config/              # Configuration files (knowledge sources, etc.)
└── tests/               # Unit and integration tests
```
