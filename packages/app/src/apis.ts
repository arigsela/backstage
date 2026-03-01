/**
 * Custom API Factories (apis.ts)
 * ================================
 *
 * WHAT ARE UTILITY APIS?
 * Backstage's frontend uses a dependency injection system called "Utility APIs".
 * Plugins and components don't import services directly — they request them by
 * reference (an "ApiRef"), and the app provides the implementation.
 *
 * This file defines custom API factory overrides that are passed to `createApp()`.
 * These override or extend the default API implementations.
 *
 * HOW IT WORKS:
 * 1. An ApiRef is a unique identifier for an API (like a DI token)
 * 2. A factory creates the API implementation, with access to other APIs via `deps`
 * 3. `createApp({ apis })` registers these factories in the app's API registry
 * 4. Plugins call `useApi(someApiRef)` to get the implementation at runtime
 *
 * WHY THIS MATTERS:
 * This pattern allows plugins to work with any SCM provider (GitHub, GitLab, Bitbucket)
 * without knowing which one is configured — they just ask for `scmIntegrationsApiRef`.
 */
import {
  ScmIntegrationsApi, // Provides SCM (Source Code Management) integration helpers
  scmIntegrationsApiRef, // The ApiRef (DI token) for SCM integrations
  ScmAuth, // Handles auth for SCM operations (e.g., creating repos via scaffolder)
} from '@backstage/integration-react';
import {
  AnyApiFactory, // Type for any API factory (used for the array type)
  configApiRef, // ApiRef for the Config API (reads app-config.yaml values)
  createApiFactory, // Helper to create API factories with typed dependencies
} from '@backstage/core-plugin-api';

export const apis: AnyApiFactory[] = [
  /**
   * SCM INTEGRATIONS API:
   * Reads the `integrations` config from app-config.yaml and provides helpers
   * for working with source code hosts (resolving URLs, building API endpoints, etc.)
   *
   * Used by: Catalog Import (to parse repo URLs), Scaffolder (to create repos),
   * TechDocs (to fetch doc sources from repos).
   *
   * `deps`: Declares which other APIs this factory needs (Config API in this case).
   * The DI system resolves deps automatically before calling `factory()`.
   */
  createApiFactory({
    api: scmIntegrationsApiRef,
    deps: { configApi: configApiRef },
    factory: ({ configApi }) => ScmIntegrationsApi.fromConfig(configApi),
  }),

  /**
   * SCM AUTH API:
   * Provides authentication credentials for SCM operations.
   * When the Scaffolder needs to create a GitHub repo, it uses ScmAuth to get
   * an OAuth token with the right scopes (repo:write, etc.).
   *
   * `createDefaultApiFactory()` creates a factory that delegates to the
   * configured auth provider (GitHub, GitLab, etc.) based on the target URL.
   */
  ScmAuth.createDefaultApiFactory(),
];
