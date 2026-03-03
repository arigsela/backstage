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

K8s manifests are managed in the [arigsela/kubernetes](https://github.com/arigsela/kubernetes)
GitOps repo under `base-apps/oncall-crewai/${{ values.name }}/`. The Backstage
template creates a PR there automatically. Resources are synced by the existing
**oncall-crewai** ArgoCD Application — no separate ArgoCD app is created.

**Automated by the Backstage scaffolder:**
- ECR repositories (`${{ values.name }}-orchestrator` and `${{ values.name }}-${{ values.subAgentName }}`) are created automatically
- Docker images are built and pushed to ECR during scaffolding
- Vault policy, K8s auth role, and placeholder secrets are provisioned automatically

**Post-merge steps** (after the K8s PR is merged):

1. Replace placeholder Vault secrets with real values at path `k8s-secrets/data/${{ values.vaultRole }}`
2. ArgoCD will auto-deploy once manifests are in the `main` branch

### Required Vault Secrets

| Key | Description |
|-----|-------------|
| `anthropic-api-key` | Anthropic API key for CrewAI LLM calls |
| `api-keys` | Comma-separated API keys for inter-service A2A auth |
{%- if values.enableKnowledge %}
| `openai-api-key` | OpenAI API key for RAG vector embeddings |
{%- endif %}

## Customizing Your Agent

### Adding Knowledge Sources (RAG)

Place files in `config/knowledge/` to give your agent domain-specific context:

- `.txt` files for architecture docs, runbooks, and guides
- `.json` files for API specs and structured data
- `.csv` files for tabular data (service catalogs, metrics)
- `.pdf` files for design docs and RFCs

{% if values.enableKnowledge %}
**RAG is enabled.** Knowledge files are automatically discovered, chunked, and
embedded at startup using CrewAI's built-in RAG system. The agent's context is
enriched with relevant chunks during execution — no code changes needed.

**Requirements:**
- Set `OPENAI_API_KEY` in your `.env` file (or Vault for production)
- OpenAI embeddings are used because Anthropic does not provide an embeddings API
- The `search_knowledge` tool also provides keyword-based file search as a complement to RAG

**How it works:**
1. `src/shared/knowledge.py` scans `config/knowledge/` for supported files
2. Files are wrapped in CrewAI `KnowledgeSource` objects (TextFile, JSON, CSV, PDF)
3. `agent.py` passes these to `Agent(knowledge_sources=..., embedder=...)`
4. CrewAI chunks, embeds, and indexes the content automatically
5. During execution, relevant chunks are injected into the agent's context
{% else %}
**RAG is disabled.** The `search_knowledge` tool performs keyword-based file search
against `.txt` and `.json` files in `config/knowledge/`. This is useful but does
not include vector-based semantic search.

To enable full RAG with vector embeddings, re-scaffold this project with
`enableKnowledge: true` in the Backstage template. This will:
- Auto-discover and embed knowledge files using CrewAI's RAG system
- Add OpenAI embeddings configuration (required since Anthropic has no embeddings API)
- Add `OPENAI_API_KEY` to the K8s secrets and docker-compose environment
{% endif %}

Rebuild with `docker-compose up --build` to include new knowledge files.

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
3. Add K8s manifests in the [arigsela/kubernetes](https://github.com/arigsela/kubernetes) repo under `base-apps/oncall-crewai/${{ values.name }}/`
4. Update the orchestrator's routing keywords and agent factories in `src/orchestrator/`

## Project Structure

```
${{ values.name }}/
├── src/
│   ├── shared/          # Common utilities (config, logging, models)
│   ├── orchestrator/    # Query router + A2A delegation
│   └── ${{ values.subAgentName }}/  # Sub-agent with tools and knowledge
├── docker/              # Dockerfiles per service
├── config/              # Configuration files (knowledge sources, etc.)
└── tests/               # Unit and integration tests
```
