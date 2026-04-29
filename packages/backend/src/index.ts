/**
 * Backstage Backend Entry Point
 * ==============================
 *
 * This file is the heart of the Backstage backend. It uses the "New Backend System"
 * (introduced in Backstage 1.x) which replaces the older manual wiring approach.
 *
 * KEY CONCEPT: The New Backend System
 * ------------------------------------
 * Instead of manually creating Express routers and wiring dependencies,
 * Backstage now uses a declarative plugin registration model:
 *
 *   1. `createBackend()` — creates a backend instance with sensible defaults
 *      (logging, config loading, database, HTTP server, etc.)
 *   2. `backend.add()` — registers a plugin or module. Each plugin self-describes
 *      its dependencies and routes. The backend handles wiring automatically.
 *   3. `backend.start()` — starts the HTTP server and initializes all plugins.
 *
 * PLUGIN vs MODULE:
 * - A "plugin" is a standalone feature (e.g., catalog, auth, search)
 * - A "module" extends a plugin (e.g., github-provider extends auth, pg extends search)
 * - Modules are loaded *into* their parent plugin via the dependency injection system.
 *
 * HOW IMPORTS WORK:
 * The `import('...')` calls are dynamic ES module imports. They return Promises,
 * but `backend.add()` handles the async resolution internally. This pattern
 * enables code-splitting and lazy loading of plugins.
 */

import { createBackend } from '@backstage/backend-defaults';

/**
 * Create the backend instance.
 * `@backstage/backend-defaults` provides default implementations for all core
 * services: config, logging, database, HTTP server, auth, permissions, etc.
 * These defaults can be overridden by registering custom service factories.
 */
const backend = createBackend();

/**
 * APP BACKEND
 * Serves the bundled frontend app (packages/app) from the backend.
 * In production, the frontend is built as static assets and served by this plugin
 * at the backend's baseUrl. This is why `app.baseUrl` matches `backend.baseUrl`
 * in app-config.production.yaml.
 */
backend.add(import('@backstage/plugin-app-backend'));

/**
 * PROXY BACKEND
 * Provides a proxy endpoint for the frontend to reach external services.
 * Configured via `proxy.endpoints` in app-config.yaml.
 * Useful for: CORS bypass, adding auth headers, hiding internal service URLs.
 * Example: frontend calls /api/proxy/my-service -> proxied to https://internal.api/...
 */
backend.add(import('@backstage/plugin-proxy-backend'));

/**
 * EVENTS BACKEND (Phase 4)
 * Provides an in-process event bus that other plugins subscribe to.
 *
 * IMPORTANT: Registered early so it's initialized BEFORE plugins that subscribe to it
 * (catalog, notifications, signals). If registered after those plugins, they hit 404
 * errors trying to subscribe before the events bus is ready.
 *
 * HOW IT WORKS:
 * The events backend exposes a pub/sub event bus. Plugins can:
 *   - Publish events: e.g., "catalog entity was updated"
 *   - Subscribe to events: e.g., notifications plugin listens for catalog changes
 *
 * This enables event-driven communication between plugins without tight coupling.
 * For example, the signals plugin uses events to push real-time updates to the frontend.
 *
 * See: https://backstage.io/docs/backend-system/core-services/events
 */
backend.add(import('@backstage/plugin-events-backend'));

/**
 * SCAFFOLDER (Software Templates)
 * Lets users create new projects/components from templates via a wizard UI.
 * The scaffolder executes "actions" (steps) like: fetch template, create repo, register in catalog.
 *
 * - scaffolder-backend: Core scaffolder engine and API
 * - scaffolder-backend-module-github: Adds GitHub-specific actions (create repo, PR, etc.)
 * - scaffolder-backend-module-notifications: Sends notifications when templates are executed
 */
backend.add(import('@backstage/plugin-scaffolder-backend'));
backend.add(import('@backstage/plugin-scaffolder-backend-module-github'));
backend.add(
  import('@backstage/plugin-scaffolder-backend-module-notifications'),
);

/**
 * CUSTOM SCAFFOLDER ACTIONS
 * Registers project-specific scaffolder actions that aren't provided by
 * official Backstage modules.
 *
 * Currently provides:
 * - publish:file — Writes scaffolded output to the local filesystem (for testing).
 *   Used by the CrewAI agent template during development instead of publish:github.
 *
 * See: packages/backend/src/modules/scaffolder/ for implementation details.
 */
backend.add(import('./modules/scaffolder'));

/**
 * TERASKY SCAFFOLDER UTILITIES
 * Provides additional scaffolder actions from TeraSky for working with
 * Crossplane resources and Kubernetes manifests in scaffolder templates.
 *
 * See: https://github.com/TeraSky-OSS/backstage-plugins
 */
backend.add(
  import('@terasky/backstage-plugin-scaffolder-backend-module-terasky-utils'),
);

/**
 * TECHDOCS
 * Renders Markdown documentation (via MkDocs) directly in Backstage.
 * Entities with `backstage.io/techdocs-ref` annotation get a "Docs" tab.
 *
 * Builder modes (set in app-config.yaml):
 * - 'local': Backstage builds docs on-demand (needs Docker for mkdocs container)
 * - 'external': Docs pre-built in CI/CD, stored in cloud storage (S3/GCS)
 *
 * The 'external' mode is recommended for production to avoid Docker-in-Docker issues.
 */
backend.add(import('@backstage/plugin-techdocs-backend'));

/**
 * AUTHENTICATION
 * The auth plugin provides the authentication framework. It doesn't do auth itself —
 * it relies on "provider modules" (like guest, github, google, etc.) to handle
 * the actual identity verification.
 *
 * - auth-backend: Core auth framework (manages sessions, tokens, sign-in)
 * - auth-backend-module-guest-provider: Allows sign-in without credentials (DEV ONLY!)
 *
 * SECURITY NOTE: The guest provider should NEVER be enabled in production.
 * It allows anyone to sign in as "guest" with full access.
 *
 * See: https://backstage.io/docs/auth/guest/provider
 */
backend.add(import('@backstage/plugin-auth-backend'));
backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));

/**
 * GITHUB OAUTH PROVIDER (Phase 3)
 * Enables "Sign in with GitHub" on the frontend.
 *
 * HOW IT WORKS:
 * 1. User clicks "GitHub" on the sign-in page
 * 2. Browser redirects to GitHub's OAuth consent screen
 * 3. User approves → GitHub redirects back to /api/auth/github/handler/frame
 * 4. This module exchanges the auth code for an access token
 * 5. The sign-in resolver maps the GitHub username to a Backstage User entity
 *    (e.g., GitHub user "arisela" → catalog entity user:default/arisela)
 *
 * DEFAULT SIGN-IN RESOLVER: `githubDefaultSignInResolver`
 * Maps GitHub username directly to User entity name. This means the User
 * entity in org.yaml MUST have `metadata.name` matching the GitHub username.
 * For custom mapping (e.g., by email), you'd write a custom resolver.
 *
 * REQUIRES: auth.providers.github config in app-config.yaml with clientId/clientSecret.
 * See: https://backstage.io/docs/auth/github/provider
 */
backend.add(import('@backstage/plugin-auth-backend-module-github-provider'));

/**
 * SOFTWARE CATALOG
 * The catalog is the core of Backstage — it tracks all your software entities:
 * Components, APIs, Systems, Resources, Users, Groups, etc.
 *
 * - catalog-backend: Core catalog engine (CRUD, entity processing pipeline, refresh loop)
 * - catalog-backend-module-scaffolder-entity-model: Adds "Template" as a valid entity kind
 *   (so scaffolder templates can be registered in the catalog)
 * - catalog-backend-module-logs: Subscribes to catalog errors and logs them
 *   (helpful for debugging entity processing failures)
 *
 * HOW THE CATALOG WORKS:
 * 1. "Locations" point to YAML files (local files, GitHub URLs, etc.)
 * 2. The catalog processor reads those files on a refresh schedule
 * 3. Entities are validated, transformed, and stored in the database
 * 4. Relations between entities (e.g., "ownedBy", "providesApi") are computed
 *
 * See: https://backstage.io/docs/features/software-catalog/
 */
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(
  import('@backstage/plugin-catalog-backend-module-scaffolder-entity-model'),
);
backend.add(import('@backstage/plugin-catalog-backend-module-logs'));

/**
 * GITHUB CATALOG DISCOVERY (Phase 4)
 * Automatically discovers and imports entities from GitHub repositories.
 *
 * HOW IT WORKS:
 * 1. On a schedule (configured in app-config.yaml under catalog.providers.github),
 *    this module scans the configured GitHub organization/user for repositories
 * 2. It looks for a `catalog-info.yaml` file (or custom path) in each repo
 * 3. Any valid entity definitions found are automatically imported into the catalog
 *
 * This replaces manual "Register existing component" imports — any repo in your
 * GitHub org that has a catalog-info.yaml will appear in Backstage automatically.
 *
 * REQUIRES: A GITHUB_TOKEN with `repo` scope (configured in integrations.github)
 * See: https://backstage.io/docs/integrations/github/discovery
 */
backend.add(import('@backstage/plugin-catalog-backend-module-github'));

/**
 * TERASKY KUBERNETES INGESTOR (Catalog Provider)
 * Discovers Kubernetes workloads (and Crossplane Claims/XRs) and ingests them
 * into the Backstage catalog as Component/Resource entities automatically.
 *
 * Configured via `kubernetesIngestor:` in app-config.yaml.
 * See: https://github.com/TeraSky-OSS/backstage-plugins
 */
backend.add(import('@terasky/backstage-plugin-kubernetes-ingestor'));

/**
 * PERMISSIONS
 * Backstage has a built-in permissions framework for access control.
 *
 * - permission-backend: Core permission evaluation engine
 * - permission-backend-module-allow-all-policy: A policy that permits everything (DEV ONLY!)
 *
 * HOW PERMISSIONS WORK:
 * 1. A plugin checks "can this user do X?" via the permissions API
 * 2. The permission backend evaluates the request against the active policy
 * 3. The policy returns ALLOW, DENY, or CONDITIONAL
 *
 * SECURITY NOTE: The allow-all policy should be replaced in production
 * with a real policy that enforces access control.
 *
 * See: https://backstage.io/docs/permissions/getting-started
 */
backend.add(import('@backstage/plugin-permission-backend'));
backend.add(
  import('@backstage/plugin-permission-backend-module-allow-all-policy'),
);

/**
 * SEARCH
 * Backstage Search provides a unified search experience across all plugins.
 *
 * Architecture (3 layers):
 * 1. Search Backend: Orchestrates indexing and query routing
 * 2. Search Engine: Stores and queries the actual search index
 *    - `search-backend-module-pg`: Uses PostgreSQL full-text search (requires PG!)
 *    - Alternative: Elasticsearch, Lunr (in-memory, dev only)
 * 3. Collators: Gather data FROM plugins TO feed INTO the search index
 *    - `search-backend-module-catalog`: Indexes catalog entities
 *    - `search-backend-module-techdocs`: Indexes TechDocs content
 *
 * NOTE: The PG search module logs "not supported" warnings when running with SQLite.
 * This will resolve once we switch to PostgreSQL in Phase 2.
 */
backend.add(import('@backstage/plugin-search-backend'));
backend.add(import('@backstage/plugin-search-backend-module-pg'));
backend.add(import('@backstage/plugin-search-backend-module-catalog'));
backend.add(import('@backstage/plugin-search-backend-module-techdocs'));

/**
 * KUBERNETES
 * Shows Kubernetes resource status (pods, deployments, etc.) on entity pages.
 * Entities with `backstage.io/kubernetes-id` annotation get a "Kubernetes" tab.
 *
 * Access modes (configured in app-config.yaml under `kubernetes:`):
 * - serviceAccount: Uses in-cluster ServiceAccount token (production, configured in app-config.yaml)
 * - localKubectlProxy: Connects via kubectl proxy on localhost:8001 (local dev, configured in app-config.local.yaml)
 * - google/aws/azure: Cloud provider-specific authentication
 *
 * Local dev: Run `kubectl proxy` in a separate terminal before starting Backstage.
 */
backend.add(import('@backstage/plugin-kubernetes-backend'));

/**
 * TERASKY CROSSPLANE RESOURCES (Backend)
 * Backend companion to the Crossplane resources frontend plugin. Exposes APIs
 * for fetching Crossplane Claim/XR/composed-resource details so the entity
 * page tab can render them.
 *
 * See: https://github.com/TeraSky-OSS/backstage-plugins
 */
backend.add(import('@terasky/backstage-plugin-crossplane-resources-backend'));

/**
 * NOTIFICATIONS & SIGNALS
 * - notifications-backend: Provides an in-app notification system
 *   (bell icon in the UI, notification center, read/unread tracking)
 * - signals-backend: Enables real-time push updates via Server-Sent Events (SSE)
 *   (used by notifications and other plugins for live UI updates)
 *
 * These plugins subscribe to the events bus (provided by events-backend above)
 * to receive real-time updates about catalog changes, template executions, etc.
 */
backend.add(import('@backstage/plugin-notifications-backend'));
backend.add(import('@backstage/plugin-signals-backend'));

/**
 * Start the backend!
 * This initializes all registered plugins, starts the HTTP server on the
 * configured port (default: 7007), and begins the catalog refresh loop.
 */
backend.start();
