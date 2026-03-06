# Chores Tracker Knowledge Sources

These knowledge files are prepared for the **Chores Tracker Knowledge Agent**
(the first use case of the CrewAI agent Backstage template).

## How to Use

After running the CrewAI agent template from Backstage with the chores-tracker
parameters, copy these files into the generated project's knowledge directory:

```bash
cp *.txt *.json /path/to/chores-knowledge-agent/config/knowledge/
```

Then rebuild the Docker image to include the knowledge files:

```bash
cd /path/to/chores-knowledge-agent
docker-compose up --build
```

## Files

| File | Description |
|------|-------------|
| `architecture.txt` | System architecture, tech stack, service dependencies |
| `api-docs.json` | API endpoints, request/response schemas, auth details |
| `deployment-guide.txt` | GitOps deployment process, canary strategy, secrets |
| `troubleshooting.txt` | Common issues with diagnostic steps and solutions |
| `data-model.txt` | Database schema, entity relationships, constraints |

## Template Parameters

Use these values when running the template:

- **name:** `chores-knowledge-agent`
- **description:** "AI agent with deep knowledge of the Chores Tracker application"
- **owner:** `group:platform-engineering`
- **routingKeywords:** "chores, tasks, assignments, household, todo, schedule, family, members"
- **subAgentName:** `knowledge-agent`
- **subAgentDisplayName:** "Chores Tracker Knowledge Specialist"
- **subAgentRole:** "Chores Tracker Application Expert"
- **subAgentGoal:** "Answer questions about the Chores Tracker app architecture, API, deployment, and troubleshooting"
- **enableKnowledge:** true
- **domain:** `chores-agent.arigsela.com`
- **vaultRole:** `chores-knowledge-agent`
