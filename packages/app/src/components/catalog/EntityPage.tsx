import { Button, Grid } from '@material-ui/core';
import {
  EntityApiDefinitionCard,
  EntityConsumedApisCard,
  EntityConsumingComponentsCard,
  EntityHasApisCard,
  EntityProvidedApisCard,
  EntityProvidingComponentsCard,
} from '@backstage/plugin-api-docs';
import {
  EntityAboutCard,
  EntityDependsOnComponentsCard,
  EntityDependsOnResourcesCard,
  EntityHasComponentsCard,
  EntityHasResourcesCard,
  EntityHasSubcomponentsCard,
  EntityHasSystemsCard,
  EntityLayout,
  EntityLinksCard,
  EntitySwitch,
  EntityOrphanWarning,
  EntityProcessingErrorsPanel,
  isComponentType,
  isKind,
  hasCatalogProcessingErrors,
  isOrphan,
  hasRelationWarnings,
  EntityRelationWarning,
} from '@backstage/plugin-catalog';
import {
  EntityUserProfileCard,
  EntityGroupProfileCard,
  EntityMembersListCard,
  EntityOwnershipCard,
} from '@backstage/plugin-org';
import { EntityTechdocsContent } from '@backstage/plugin-techdocs';
import { EmptyState } from '@backstage/core-components';
import {
  Direction,
  EntityCatalogGraphCard,
} from '@backstage/plugin-catalog-graph';
import {
  RELATION_API_CONSUMED_BY,
  RELATION_API_PROVIDED_BY,
  RELATION_CONSUMES_API,
  RELATION_DEPENDENCY_OF,
  RELATION_DEPENDS_ON,
  RELATION_HAS_PART,
  RELATION_PART_OF,
  RELATION_PROVIDES_API,
} from '@backstage/catalog-model';

import { TechDocsAddons } from '@backstage/plugin-techdocs-react';
import { ReportIssue } from '@backstage/plugin-techdocs-module-addons-contrib';

import {
  EntityKubernetesContent,
  isKubernetesAvailable,
} from '@backstage/plugin-kubernetes';

import {
  CrossplaneResourceGraphSelector,
  CrossplaneResourcesTableSelector,
  IfCrossplaneResourceGraphAvailable,
  IfCrossplaneResourcesListAvailable,
  isCrossplaneAvailable,
} from '@terasky/backstage-plugin-crossplane-resources-frontend';

import { isKagentAgent, KagentAboutCardContent } from './KagentAgentCard';

// Container CVE surfacing: Overview card + Security tab content. Both call
// useCveReport() internally and take no props — see packages/app/src/components/cve.
import { CveFindingsTable, CveSummaryCard } from '../cve';

const techdocsContent = (
  <EntityTechdocsContent>
    <TechDocsAddons>
      <ReportIssue />
    </TechDocsAddons>
  </EntityTechdocsContent>
);

// kagent 1.0 "About this agent" card — see ./KagentAgentCard.tsx.
const kagentAboutCard = (
  <EntitySwitch>
    <EntitySwitch.Case if={isKagentAgent}>
      <KagentAboutCardContent />
    </EntitySwitch.Case>
  </EntitySwitch>
);

// The CVE card is meaningful only where the Kubernetes plugin can resolve the
// entity's running images — that resolution IS the CVE-to-entity join. Where
// Kubernetes is unavailable the card is not rendered at all, rather than
// rendering an empty card that would read as "no vulnerabilities".
const cveSummaryCard = (
  <EntitySwitch>
    <EntitySwitch.Case if={isKubernetesAvailable}>
      <Grid item md={6} xs={12}>
        <CveSummaryCard />
      </Grid>
    </EntitySwitch.Case>
  </EntitySwitch>
);

const cicdContent = (
  // This is an example of how you can implement your company's logic in entity page.
  // You can for example enforce that all components of type 'service' should use GitHubActions
  <EntitySwitch>
    {/*
      Here you can add support for different CI/CD services, for example
      using @backstage-community/plugin-github-actions as follows:
      <EntitySwitch.Case if={isGithubActionsAvailable}>
        <EntityGithubActionsContent />
      </EntitySwitch.Case>
     */}
    <EntitySwitch.Case>
      <EmptyState
        title="No CI/CD available for this entity"
        missing="info"
        description="You need to add an annotation to your component if you want to enable CI/CD for it. You can read more about annotations in Backstage by clicking the button below."
        action={
          <Button
            variant="contained"
            color="primary"
            href="https://backstage.io/docs/features/software-catalog/well-known-annotations"
          >
            Read more
          </Button>
        }
      />
    </EntitySwitch.Case>
  </EntitySwitch>
);

const entityWarningContent = (
  <>
    <EntitySwitch>
      <EntitySwitch.Case if={isOrphan}>
        <Grid item xs={12}>
          <EntityOrphanWarning />
        </Grid>
      </EntitySwitch.Case>
    </EntitySwitch>

    <EntitySwitch>
      <EntitySwitch.Case if={hasRelationWarnings}>
        <Grid item xs={12}>
          <EntityRelationWarning />
        </Grid>
      </EntitySwitch.Case>
    </EntitySwitch>

    <EntitySwitch>
      <EntitySwitch.Case if={hasCatalogProcessingErrors}>
        <Grid item xs={12}>
          <EntityProcessingErrorsPanel />
        </Grid>
      </EntitySwitch.Case>
    </EntitySwitch>
  </>
);

const overviewContent = (
  <Grid container spacing={3} alignItems="stretch">
    {entityWarningContent}
    <Grid item md={6}>
      <EntityAboutCard />
    </Grid>
    <Grid item md={6} xs={12}>
      <EntityCatalogGraphCard height={400} />
    </Grid>

    {kagentAboutCard}

    {cveSummaryCard}

    <Grid item md={4} xs={12}>
      <EntityLinksCard />
    </Grid>
    <Grid item md={8} xs={12}>
      <EntityHasSubcomponentsCard />
    </Grid>
  </Grid>
);

// Security tab: actionable container CVEs for the images this entity runs.
// Defined once and shared across all four layouts below rather than
// copy-pasted, since the route is identical everywhere it appears. Guarded
// by isKubernetesAvailable for the same reason as cveSummaryCard above — the
// Kubernetes plugin's image resolution is what joins CVE findings to this
// entity in the first place.
const securityRoute = (
  <EntityLayout.Route
    path="/security"
    title="Security"
    if={isKubernetesAvailable}
  >
    <CveFindingsTable />
  </EntityLayout.Route>
);

// kagent: dedicated 4-tab layout (Overview / Kubernetes / Security / Docs) for
// entities with spec.type='kagent-agent'. Since kagent 1.0 the entity is
// ingested from the api.kagent.dev Agent itself and there is no per-agent
// Deployment, so the Kubernetes and Security tabs only appear when the Agent
// carries a terasky.backstage.io/kubernetes-label-selector annotation (the
// ingestor computes no selector for custom kinds); the Kubernetes tab then
// lists the matching Agent/AgentTemplate in its Custom Resources panel
// (kubernetes.customResources in app-config).
const kagentAgentPage = (
  <EntityLayout>
    <EntityLayout.Route path="/" title="Overview">
      {overviewContent}
    </EntityLayout.Route>

    <EntityLayout.Route
      path="/kubernetes"
      title="Kubernetes"
      if={isKubernetesAvailable}
    >
      <EntityKubernetesContent />
    </EntityLayout.Route>

    {securityRoute}

    <EntityLayout.Route path="/docs" title="Docs">
      {techdocsContent}
    </EntityLayout.Route>
  </EntityLayout>
);

const serviceEntityPage = (
  <EntityLayout>
    <EntityLayout.Route path="/" title="Overview">
      {overviewContent}
    </EntityLayout.Route>

    <EntityLayout.Route path="/ci-cd" title="CI/CD">
      {cicdContent}
    </EntityLayout.Route>

    <EntityLayout.Route
      path="/kubernetes"
      title="Kubernetes"
      if={isKubernetesAvailable}
    >
      <EntityKubernetesContent />
    </EntityLayout.Route>

    {securityRoute}

    <EntityLayout.Route
      path="/crossplane"
      title="Crossplane"
      if={isCrossplaneAvailable}
    >
      <Grid container spacing={3} alignItems="stretch">
        <IfCrossplaneResourcesListAvailable>
          <Grid item xs={12}>
            <CrossplaneResourcesTableSelector />
          </Grid>
        </IfCrossplaneResourcesListAvailable>
        <IfCrossplaneResourceGraphAvailable>
          <Grid item xs={12}>
            <CrossplaneResourceGraphSelector />
          </Grid>
        </IfCrossplaneResourceGraphAvailable>
      </Grid>
    </EntityLayout.Route>

    <EntityLayout.Route path="/api" title="API">
      <Grid container spacing={3} alignItems="stretch">
        <Grid item md={6}>
          <EntityProvidedApisCard />
        </Grid>
        <Grid item md={6}>
          <EntityConsumedApisCard />
        </Grid>
      </Grid>
    </EntityLayout.Route>

    <EntityLayout.Route path="/dependencies" title="Dependencies">
      <Grid container spacing={3} alignItems="stretch">
        <Grid item md={6}>
          <EntityDependsOnComponentsCard />
        </Grid>
        <Grid item md={6}>
          <EntityDependsOnResourcesCard />
        </Grid>
      </Grid>
    </EntityLayout.Route>

    <EntityLayout.Route path="/docs" title="Docs">
      {techdocsContent}
    </EntityLayout.Route>
  </EntityLayout>
);

const websiteEntityPage = (
  <EntityLayout>
    <EntityLayout.Route path="/" title="Overview">
      {overviewContent}
    </EntityLayout.Route>

    <EntityLayout.Route path="/ci-cd" title="CI/CD">
      {cicdContent}
    </EntityLayout.Route>

    <EntityLayout.Route
      path="/kubernetes"
      title="Kubernetes"
      if={isKubernetesAvailable}
    >
      <EntityKubernetesContent />
    </EntityLayout.Route>

    {securityRoute}

    <EntityLayout.Route path="/dependencies" title="Dependencies">
      <Grid container spacing={3} alignItems="stretch">
        <Grid item md={6}>
          <EntityDependsOnComponentsCard />
        </Grid>
        <Grid item md={6}>
          <EntityDependsOnResourcesCard />
        </Grid>
      </Grid>
    </EntityLayout.Route>

    <EntityLayout.Route path="/docs" title="Docs">
      {techdocsContent}
    </EntityLayout.Route>
  </EntityLayout>
);

/**
 * NOTE: This page is designed to work on small screens such as mobile devices.
 * This is based on Material UI Grid. If breakpoints are used, each grid item must set the `xs` prop to a column size or to `true`,
 * since this does not default. If no breakpoints are used, the items will equitably share the available space.
 * https://material-ui.com/components/grid/#basic-grid.
 */

const defaultEntityPage = (
  <EntityLayout>
    <EntityLayout.Route path="/" title="Overview">
      {overviewContent}
    </EntityLayout.Route>

    {/*
      Unlike the three layouts above, this one has no dedicated Kubernetes
      route — most entities that fall through to it aren't backed by a
      workload. securityRoute is included anyway, positioned where the
      Kubernetes route would sit in the other layouts (just ahead of Docs),
      because its own if={isKubernetesAvailable} guard already makes it
      inert for entities without Kubernetes. Omitting it here would silently
      blind any entity that reaches this layout but does happen to run a
      scanned image.
    */}
    {securityRoute}

    <EntityLayout.Route path="/docs" title="Docs">
      {techdocsContent}
    </EntityLayout.Route>
  </EntityLayout>
);

const componentPage = (
  <EntitySwitch>
    <EntitySwitch.Case if={isComponentType('service')}>
      {serviceEntityPage}
    </EntitySwitch.Case>

    <EntitySwitch.Case if={isComponentType('website')}>
      {websiteEntityPage}
    </EntitySwitch.Case>

    <EntitySwitch.Case if={isComponentType('kagent-agent')}>
      {kagentAgentPage}
    </EntitySwitch.Case>

    <EntitySwitch.Case>{defaultEntityPage}</EntitySwitch.Case>
  </EntitySwitch>
);

const apiPage = (
  <EntityLayout>
    <EntityLayout.Route path="/" title="Overview">
      <Grid container spacing={3}>
        {entityWarningContent}
        <Grid item md={6}>
          <EntityAboutCard />
        </Grid>
        <Grid item md={6} xs={12}>
          <EntityCatalogGraphCard height={400} />
        </Grid>
        <Grid item md={4} xs={12}>
          <EntityLinksCard />
        </Grid>
        <Grid container item md={12}>
          <Grid item md={6}>
            <EntityProvidingComponentsCard />
          </Grid>
          <Grid item md={6}>
            <EntityConsumingComponentsCard />
          </Grid>
        </Grid>
      </Grid>
    </EntityLayout.Route>

    <EntityLayout.Route path="/definition" title="Definition">
      <Grid container spacing={3}>
        <Grid item xs={12}>
          <EntityApiDefinitionCard />
        </Grid>
      </Grid>
    </EntityLayout.Route>
  </EntityLayout>
);

const userPage = (
  <EntityLayout>
    <EntityLayout.Route path="/" title="Overview">
      <Grid container spacing={3}>
        {entityWarningContent}
        <Grid item xs={12} md={6}>
          <EntityUserProfileCard />
        </Grid>
        <Grid item xs={12} md={6}>
          <EntityOwnershipCard />
        </Grid>
      </Grid>
    </EntityLayout.Route>
  </EntityLayout>
);

const groupPage = (
  <EntityLayout>
    <EntityLayout.Route path="/" title="Overview">
      <Grid container spacing={3}>
        {entityWarningContent}
        <Grid item xs={12} md={6}>
          <EntityGroupProfileCard />
        </Grid>
        <Grid item xs={12} md={6}>
          <EntityOwnershipCard />
        </Grid>
        <Grid item xs={12} md={6}>
          <EntityMembersListCard />
        </Grid>
        <Grid item xs={12} md={6}>
          <EntityLinksCard />
        </Grid>
      </Grid>
    </EntityLayout.Route>
  </EntityLayout>
);

const systemPage = (
  <EntityLayout>
    <EntityLayout.Route path="/" title="Overview">
      <Grid container spacing={3} alignItems="stretch">
        {entityWarningContent}
        <Grid item md={6}>
          <EntityAboutCard />
        </Grid>
        <Grid item md={6} xs={12}>
          <EntityCatalogGraphCard height={400} />
        </Grid>
        <Grid item md={4} xs={12}>
          <EntityLinksCard />
        </Grid>
        <Grid item md={8}>
          <EntityHasComponentsCard />
        </Grid>
        <Grid item md={6}>
          <EntityHasApisCard />
        </Grid>
        <Grid item md={6}>
          <EntityHasResourcesCard />
        </Grid>
      </Grid>
    </EntityLayout.Route>
    <EntityLayout.Route path="/diagram" title="Diagram">
      <EntityCatalogGraphCard
        direction={Direction.TOP_BOTTOM}
        title="System Diagram"
        height={700}
        relations={[
          RELATION_PART_OF,
          RELATION_HAS_PART,
          RELATION_API_CONSUMED_BY,
          RELATION_API_PROVIDED_BY,
          RELATION_CONSUMES_API,
          RELATION_PROVIDES_API,
          RELATION_DEPENDENCY_OF,
          RELATION_DEPENDS_ON,
        ]}
        unidirectional={false}
      />
    </EntityLayout.Route>
  </EntityLayout>
);

const domainPage = (
  <EntityLayout>
    <EntityLayout.Route path="/" title="Overview">
      <Grid container spacing={3} alignItems="stretch">
        {entityWarningContent}
        <Grid item md={6}>
          <EntityAboutCard />
        </Grid>
        <Grid item md={6} xs={12}>
          <EntityCatalogGraphCard height={400} />
        </Grid>
        <Grid item md={6}>
          <EntityHasSystemsCard />
        </Grid>
      </Grid>
    </EntityLayout.Route>
  </EntityLayout>
);

export const entityPage = (
  <EntitySwitch>
    <EntitySwitch.Case if={isKind('component')} children={componentPage} />
    <EntitySwitch.Case if={isKind('api')} children={apiPage} />
    <EntitySwitch.Case if={isKind('group')} children={groupPage} />
    <EntitySwitch.Case if={isKind('user')} children={userPage} />
    <EntitySwitch.Case if={isKind('system')} children={systemPage} />
    <EntitySwitch.Case if={isKind('domain')} children={domainPage} />

    <EntitySwitch.Case>{defaultEntityPage}</EntitySwitch.Case>
  </EntitySwitch>
);
