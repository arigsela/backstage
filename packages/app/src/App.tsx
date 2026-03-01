/**
 * Backstage Frontend App Entry Point
 * ====================================
 *
 * This file defines the entire frontend application: routing, plugins, auth, and layout.
 * Backstage uses React with a plugin-based architecture where each feature (catalog,
 * TechDocs, scaffolder, etc.) is a separate npm package providing pages and components.
 *
 * KEY CONCEPTS:
 * - `createApp()`: Factory that assembles the Backstage frontend from config, APIs, and routes
 * - `bindRoutes()`: Connects cross-plugin navigation (e.g., catalog -> scaffolder)
 * - `FlatRoutes`: Backstage's route system (all routes at one level, no nesting)
 * - `SignInPage`: Configurable auth gate shown before the app loads
 */

// --- React Router for client-side navigation ---
import { Navigate, Route } from 'react-router-dom';

// --- Plugin Imports ---
// Each plugin exports: page components, plugin objects (for route binding), and sometimes hooks.
// The plugin object (e.g., `catalogPlugin`) contains route definitions for cross-plugin linking.

// API Docs: Browse and view API definitions (OpenAPI, gRPC, GraphQL, AsyncAPI)
import { apiDocsPlugin, ApiExplorerPage } from '@backstage/plugin-api-docs';

// Catalog: The central registry of all software entities (components, APIs, systems, etc.)
import {
  CatalogEntityPage, // Individual entity detail page (with tabs: Overview, CI/CD, Docs, etc.)
  CatalogIndexPage, // The main catalog listing page (filterable table of all entities)
  catalogPlugin, // Plugin object for route binding
} from '@backstage/plugin-catalog';

// Catalog Import: UI for registering new entities by providing a YAML URL
import {
  CatalogImportPage,
  catalogImportPlugin,
} from '@backstage/plugin-catalog-import';

// Scaffolder: "Create" page — lets users spin up new projects from software templates
import { ScaffolderPage, scaffolderPlugin } from '@backstage/plugin-scaffolder';

// Org: Displays organizational structure (teams, users, group hierarchy)
import { orgPlugin } from '@backstage/plugin-org';

// Search: Unified search across catalog entities, TechDocs, and any indexed content
import { SearchPage } from '@backstage/plugin-search';

// TechDocs: Renders MkDocs-based documentation directly in Backstage
import {
  TechDocsIndexPage, // Lists all entities with documentation
  techdocsPlugin, // Plugin object for route binding
  TechDocsReaderPage, // Renders the actual documentation content
} from '@backstage/plugin-techdocs';
import { TechDocsAddons } from '@backstage/plugin-techdocs-react';
import { ReportIssue } from '@backstage/plugin-techdocs-module-addons-contrib';

// User Settings: Personal preferences page (theme, notifications, auth tokens)
import { UserSettingsPage } from '@backstage/plugin-user-settings';

// Local app modules
import { apis } from './apis'; // Custom API factories (see apis.ts)
import { entityPage } from './components/catalog/EntityPage'; // Tabs shown on entity detail pages
import { searchPage } from './components/search/SearchPage'; // Custom search result layout
import { Root } from './components/Root'; // App shell: sidebar navigation + header

// Core Backstage components
import {
  AlertDisplay, // Shows global alerts/errors as toast notifications
  OAuthRequestDialog, // Popup dialog for OAuth consent flows (e.g., GitHub token scopes)
  SignInPage, // Configurable sign-in gate (shown before app loads)
} from '@backstage/core-components';
import { createApp } from '@backstage/app-defaults';
import { githubAuthApiRef } from '@backstage/core-plugin-api';
import { AppRouter, FlatRoutes } from '@backstage/core-app-api';

// Additional plugin pages
import { CatalogGraphPage } from '@backstage/plugin-catalog-graph'; // Visual graph of entity relations
import { RequirePermission } from '@backstage/plugin-permission-react'; // Permission-gate wrapper
import { catalogEntityCreatePermission } from '@backstage/plugin-catalog-common/alpha';
import { NotificationsPage } from '@backstage/plugin-notifications'; // In-app notification center
import { SignalsDisplay } from '@backstage/plugin-signals'; // Real-time update listener (SSE)

/**
 * CREATE THE APP
 *
 * `createApp()` is the main factory for the Backstage frontend. It takes:
 * - `apis`: Custom API factory overrides (see apis.ts)
 * - `bindRoutes`: Connects cross-plugin navigation links
 * - `components`: Override core UI components (like SignInPage)
 */
const app = createApp({
  apis,

  /**
   * ROUTE BINDING
   *
   * Backstage plugins define "external routes" — navigation targets they link to
   * but don't own. For example, the catalog has a "Create Component" button, but
   * the actual creation page lives in the scaffolder plugin.
   *
   * `bindRoutes` connects these external route references to actual routes in other plugins.
   * Without this, cross-plugin navigation links would be broken.
   */
  bindRoutes({ bind }) {
    // Catalog plugin: "Create Component" -> Scaffolder, "View Docs" -> TechDocs
    bind(catalogPlugin.externalRoutes, {
      createComponent: scaffolderPlugin.routes.root,
      viewTechDoc: techdocsPlugin.routes.docRoot,
      createFromTemplate: scaffolderPlugin.routes.selectedTemplate,
    });
    // API Docs: "Register API" -> Catalog Import page
    bind(apiDocsPlugin.externalRoutes, {
      registerApi: catalogImportPlugin.routes.importPage,
    });
    // Scaffolder: "Register Component" -> Catalog Import, "View Docs" -> TechDocs
    bind(scaffolderPlugin.externalRoutes, {
      registerComponent: catalogImportPlugin.routes.importPage,
      viewTechDoc: techdocsPlugin.routes.docRoot,
    });
    // Org plugin: "View in Catalog" -> Catalog index
    bind(orgPlugin.externalRoutes, {
      catalogIndex: catalogPlugin.routes.catalogIndex,
    });
  },

  /**
   * COMPONENT OVERRIDES
   *
   * The `components` option lets you replace core UI components.
   * Here we configure the SignInPage with available auth providers.
   *
   * PROVIDERS ARRAY: Each string maps to a built-in provider resolver:
   *   - 'guest'  → Passwordless sign-in (dev only, no real identity)
   *   - 'github' → GitHub OAuth (redirects to GitHub for consent)
   *
   * WHY NO `auto` PROP: With multiple providers, we need to show the
   * selection screen so the user can choose how to sign in. The `auto`
   * prop only makes sense with a single provider (auto-signs-in).
   *
   * PRODUCTION NOTE: Remove 'guest' from providers in production config
   * to force real authentication via GitHub OAuth.
   */
  components: {
    SignInPage: props => {
      const providers: Array<
        | 'guest'
        | { id: string; title: string; message: string; apiRef: typeof githubAuthApiRef }
      > = [
        // Guest sign-in is only available in development (yarn dev).
        // The production Docker build sets NODE_ENV=production, hiding this option.
        ...(process.env.NODE_ENV !== 'production' ? (['guest'] as const) : []),
        {
          id: 'github-auth-provider',
          title: 'GitHub',
          message: 'Sign in using GitHub',
          apiRef: githubAuthApiRef,
        },
      ];
      return <SignInPage {...props} providers={providers} />;
    },
  },
});

/**
 * ROUTE DEFINITIONS
 *
 * Backstage uses `FlatRoutes` — all routes live at the top level (no nesting).
 * Each `<Route>` maps a URL path to a plugin page component.
 *
 * Route structure:
 * /                 -> Redirects to /catalog (the default landing page)
 * /catalog          -> CatalogIndexPage (browse all entities)
 * /catalog/:ns/:kind/:name -> CatalogEntityPage (entity detail with tabs)
 * /docs             -> TechDocsIndexPage (browse all docs)
 * /docs/:ns/:kind/:name/* -> TechDocsReaderPage (read documentation)
 * /create           -> ScaffolderPage (create from templates)
 * /api-docs         -> ApiExplorerPage (browse APIs)
 * /catalog-import   -> CatalogImportPage (register new entities) [PERMISSION GATED]
 * /search           -> SearchPage (unified search)
 * /settings         -> UserSettingsPage (personal preferences)
 * /catalog-graph    -> CatalogGraphPage (visual entity relationship graph)
 * /notifications    -> NotificationsPage (notification center)
 */
const routes = (
  <FlatRoutes>
    {/* Default route: redirect to the catalog as the home page */}
    <Route path="/" element={<Navigate to="catalog" />} />

    {/* CATALOG: Main listing of all entities (components, APIs, systems, etc.) */}
    <Route path="/catalog" element={<CatalogIndexPage />} />

    {/*
     * ENTITY DETAIL PAGE
     * URL pattern: /catalog/default/component/my-service
     * The :namespace, :kind, :name params identify the entity.
     * {entityPage} is the tab layout defined in components/catalog/EntityPage.tsx
     */}
    <Route
      path="/catalog/:namespace/:kind/:name"
      element={<CatalogEntityPage />}
    >
      {entityPage}
    </Route>

    {/* TECHDOCS: Documentation browser and reader */}
    <Route path="/docs" element={<TechDocsIndexPage />} />
    <Route
      path="/docs/:namespace/:kind/:name/*"
      element={<TechDocsReaderPage />}
    >
      {/* TechDocs Addons: Additional features rendered within docs pages */}
      <TechDocsAddons>
        {/* ReportIssue: Adds a "Report Issue" button to docs pages that opens a GitHub issue */}
        <ReportIssue />
      </TechDocsAddons>
    </Route>

    {/* SCAFFOLDER: Create new projects/components from software templates */}
    <Route path="/create" element={<ScaffolderPage />} />

    {/* API DOCS: Browse and explore registered API definitions */}
    <Route path="/api-docs" element={<ApiExplorerPage />} />

    {/*
     * CATALOG IMPORT: Register new entities by providing a YAML file URL.
     * Wrapped in RequirePermission — only users with `catalogEntityCreatePermission`
     * can access this page. This is an example of Backstage's permission system in action.
     */}
    <Route
      path="/catalog-import"
      element={
        <RequirePermission permission={catalogEntityCreatePermission}>
          <CatalogImportPage />
        </RequirePermission>
      }
    />

    {/* SEARCH: Unified search with custom result layout from searchPage component */}
    <Route path="/search" element={<SearchPage />}>
      {searchPage}
    </Route>

    {/* USER SETTINGS: Theme preferences, auth tokens, notification settings */}
    <Route path="/settings" element={<UserSettingsPage />} />

    {/* CATALOG GRAPH: Visual graph showing entity relationships (ownedBy, dependsOn, etc.) */}
    <Route path="/catalog-graph" element={<CatalogGraphPage />} />

    {/* NOTIFICATIONS: In-app notification center (bell icon in sidebar) */}
    <Route path="/notifications" element={<NotificationsPage />} />
  </FlatRoutes>
);

/**
 * APP ROOT
 *
 * `app.createRoot()` creates the React component tree that is the entire application.
 *
 * Layout structure (outside-in):
 * 1. AlertDisplay — Global toast notifications (errors, warnings, info)
 * 2. OAuthRequestDialog — Popup for OAuth consent (e.g., when a plugin needs a GitHub token)
 * 3. SignalsDisplay — Listens for real-time Server-Sent Events (SSE) for live updates
 * 4. AppRouter — Provides React Router context for client-side navigation
 * 5. Root — The app shell (sidebar navigation + header), defined in components/Root/
 * 6. {routes} — The actual page content based on the current URL
 *
 * This component tree is rendered by index.tsx (the webpack entry point).
 */
export default app.createRoot(
  <>
    <AlertDisplay />
    <OAuthRequestDialog />
    <SignalsDisplay />
    <AppRouter>
      <Root>{routes}</Root>
    </AppRouter>
  </>,
);
