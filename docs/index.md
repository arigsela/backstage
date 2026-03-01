# Backstage Developer Portal

Welcome to the internal developer portal documentation. This site is rendered by
[TechDocs](https://backstage.io/docs/features/techdocs/) directly inside Backstage.

## What is Backstage?

[Backstage](https://backstage.io) is an open-source developer portal platform created
by Spotify. It provides a unified interface for managing your software ecosystem:

- **Software Catalog** — Track every service, website, library, and API in your organization
- **Software Templates** — Scaffold new projects from standardized templates
- **TechDocs** — Render Markdown documentation alongside your services
- **Kubernetes** — View live pod and deployment status for your workloads
- **Search** — Find anything across all plugins with full-text search

## About This Instance

This Backstage instance is deployed as a learning exercise and homelab developer portal.

| Setting | Value |
|---|---|
| Backstage Version | 1.48.0 |
| Database | PostgreSQL 16 (Docker Compose for local, managed for production) |
| Authentication | GitHub OAuth + Guest (dev only) |
| TechDocs Builder | Local (Docker-based MkDocs) |
| Kubernetes | Homelab cluster (kubeconfig for dev, ServiceAccount for prod) |

## Getting Started

### Prerequisites

- Node.js v22+ (via nvm)
- Yarn 4.x (via corepack)
- Docker & Docker Compose (for PostgreSQL and TechDocs)
- A GitHub account with an OAuth App configured

### Running Locally

```bash
# 1. Start PostgreSQL
docker compose up -d

# 2. (Optional) Start kubectl proxy for Kubernetes plugin
kubectl proxy

# 3. Start Backstage in dev mode
yarn dev
```

The frontend will be available at `http://localhost:3000` and the backend API at
`http://localhost:7007`.

## Architecture

```
                  +-------------------+
                  |   Frontend (React) |  :3000
                  +---------+---------+
                            |
                  +---------v---------+
                  |  Backend (Node.js) |  :7007
                  +---------+---------+
                            |
              +-------------+-------------+
              |                           |
    +---------v---------+    +------------v-----------+
    |   PostgreSQL 16   |    |   GitHub API           |
    |   (catalog, auth, |    |   (OAuth, repo reads,  |
    |    search index)  |    |    catalog discovery)  |
    +-------------------+    +------------------------+
```

## Adding Documentation

To add more pages to this TechDocs site:

1. Create a new Markdown file in the `docs/` directory (e.g., `docs/architecture.md`)
2. Add it to the `nav:` section in `mkdocs.yml` at the project root
3. The page will appear in the TechDocs sidebar when the docs are rebuilt
