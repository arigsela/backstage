import { useEffect, useState } from 'react';
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
import { useEntity } from '@backstage/plugin-catalog-react';
import {
  EntityUserProfileCard,
  EntityGroupProfileCard,
  EntityMembersListCard,
  EntityOwnershipCard,
} from '@backstage/plugin-org';
import { EntityTechdocsContent } from '@backstage/plugin-techdocs';
import { EmptyState, InfoCard, MarkdownContent } from '@backstage/core-components';
import {
  Direction,
  EntityCatalogGraphCard,
} from '@backstage/plugin-catalog-graph';
import {
  Entity,
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
  kubernetesApiRef,
} from '@backstage/plugin-kubernetes';
import { useApi } from '@backstage/core-plugin-api';

import {
  CrossplaneResourceGraphSelector,
  CrossplaneResourcesTableSelector,
  IfCrossplaneResourceGraphAvailable,
  IfCrossplaneResourcesListAvailable,
  isCrossplaneAvailable,
} from '@terasky/backstage-plugin-crossplane-resources-frontend';

const techdocsContent = (
  <EntityTechdocsContent>
    <TechDocsAddons>
      <ReportIssue />
    </TechDocsAddons>
  </EntityTechdocsContent>
);

// =============================================================================
// Kagent IDP v1.7 — "About this agent" card
// =============================================================================
// Renders a Markdown summary of a kagent.dev/v1alpha2 Agent on the entity
// Overview tab. Fetches the live Agent CRD via the Backstage Kubernetes plugin
// proxy (the annotation-based approach was abandoned — kagent controller drops
// multi-line annotations during Deployment creation, breaking the propagation
// chain to TeraSky's kubernetes-ingestor).
//
// Companion spec: arigsela/kubernetes:docs/superpowers/specs/2026-05-18-kagent-idp-v1.7-design.md

const isKagentAgent = (entity: Entity): boolean =>
  entity?.spec?.type === 'kagent-agent';

interface KagentSkill {
  id: string;
  name: string;
  description: string;
  examples?: string[];
  tags?: string[];
}

interface KagentAgentSpec {
  description?: string;
  declarative?: {
    modelConfig?: string;
    memory?: { modelConfig?: string };
    systemMessage?: string;
    a2aConfig?: { skills?: KagentSkill[] };
    tools?: Array<{ type: string; agent?: { name: string } }>;
    context?: { compaction?: { compactionInterval?: number; overlapSize?: number } };
    deployment?: {
      resources?: {
        requests?: { cpu?: string; memory?: string };
        limits?: { cpu?: string; memory?: string };
      };
    };
    promptTemplate?: unknown;
  };
}

const DELEGATE_DESCRIPTIONS: Record<string, string> = {
  'k8s-agent':
    'Kubernetes cluster operations (pods, deployments, RBAC, troubleshooting)',
  'helm-agent':
    'Helm release lifecycle (install/upgrade/rollback, chart inspection)',
  'istio-agent': 'Istio service-mesh configuration and traffic management',
  'kgateway-agent': 'Kubernetes Gateway API (kgateway/Envoy)',
  'argo-rollouts-conversion-agent':
    'Convert Deployments to Argo Rollouts for progressive delivery',
  'observability-agent':
    'Prometheus + Grafana metrics and dashboard management',
};

const buildKagentMarkdown = (
  entityName: string,
  spec: KagentAgentSpec,
): string => {
  const decl = spec.declarative || {};
  const skills = decl.a2aConfig?.skills || [];
  const delegates = (decl.tools || [])
    .filter(t => t.type === 'Agent' && t.agent?.name)
    .map(t => t.agent!.name);
  const compaction = decl.context?.compaction;
  const resources = decl.deployment?.resources;

  const lines: string[] = [`# ${entityName}`, ''];
  if (spec.description) lines.push(spec.description, '');
  lines.push('## Purpose', '', decl.systemMessage || '(no system message defined)');

  if (skills.length > 0) {
    lines.push('', '## Skills');
    for (const skill of skills) {
      lines.push('', `### ${skill.name} (\`${skill.id}\`)`, '', skill.description);
      if (skill.examples?.length) {
        lines.push('', '**Examples:**');
        for (const ex of skill.examples) lines.push(`- ${ex}`);
      }
      if (skill.tags?.length) {
        lines.push('', `**Tags:** ${skill.tags.map(t => `\`${t}\``).join(', ')}`);
      }
    }
  }

  if (delegates.length > 0) {
    lines.push(
      '',
      '## Delegates to',
      '',
      'This agent can delegate tasks to the following agents:',
    );
    for (const d of delegates) {
      lines.push(`- **${d}** — ${DELEGATE_DESCRIPTIONS[d] || '(see kagent docs)'}`);
    }
  }

  lines.push('', '## Configuration', '', '| Setting | Value |', '|---|---|');
  if (decl.modelConfig) lines.push(`| Model | \`${decl.modelConfig}\` |`);
  if (decl.memory?.modelConfig)
    lines.push(`| Memory model | \`${decl.memory.modelConfig}\` |`);
  if (compaction) {
    lines.push(
      `| Compaction interval | ${compaction.compactionInterval} turns |`,
      `| Compaction overlap | ${compaction.overlapSize} turns |`,
    );
  }
  if (resources) {
    lines.push(
      `| CPU | ${resources.requests?.cpu || '?'} / ${resources.limits?.cpu || '?'} (req/lim) |`,
      `| Memory | ${resources.requests?.memory || '?'} / ${resources.limits?.memory || '?'} (req/lim) |`,
    );
  }
  lines.push(
    `| Built-in prompts | ${decl.promptTemplate ? 'included' : 'not included'} |`,
  );

  lines.push(
    '',
    '## Manage',
    '',
    `- **Edit:** hand-edit \`base-apps/kagent/agents/${entityName}.yaml\` and open a PR`,
    `- **Decommission:** use the **Decommission Kagent Agent** template in Backstage`,
  );

  return lines.join('\n');
};

const KagentAboutCardContent = () => {
  const { entity } = useEntity();
  const kubernetesApi = useApi(kubernetesApiRef);
  const [spec, setSpec] = useState<KagentAgentSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // TeraSky's kubernetes-resource-* annotations point at the Deployment
    // workload (apps/v1), not the Agent CRD itself. Our IDP convention is
    // Agent name == Deployment name == entity name, both in the kagent
    // namespace, so we use those values and hardcode the kagent API path.
    const ann = entity.metadata.annotations || {};
    const name =
      ann['terasky.backstage.io/kubernetes-resource-name'] || entity.metadata.name;
    const namespace =
      ann['terasky.backstage.io/kubernetes-resource-namespace'] || 'kagent';

    if (!name || !namespace) {
      setError('Unable to determine the Agent CRD name/namespace from the entity');
      setLoading(false);
      return;
    }

    let cancelled = false;
    kubernetesApi
      .proxy({
        clusterName: 'homelab',
        path: `/apis/kagent.dev/v1alpha2/namespaces/${namespace}/agents/${name}`,
      })
      .then(res => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((data: { spec?: KagentAgentSpec }) => {
        if (cancelled) return;
        setSpec(data.spec || {});
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entity, kubernetesApi]);

  if (loading) {
    return (
      <Grid item xs={12}>
        <InfoCard title="About this agent">
          <em>Loading agent details from cluster…</em>
        </InfoCard>
      </Grid>
    );
  }
  if (error || !spec) {
    return (
      <Grid item xs={12}>
        <InfoCard title="About this agent">
          <em>Could not load agent details: {error || 'unknown error'}</em>
        </InfoCard>
      </Grid>
    );
  }

  return (
    <Grid item xs={12}>
      <InfoCard title="About this agent">
        <MarkdownContent content={buildKagentMarkdown(entity.metadata.name, spec)} />
      </InfoCard>
    </Grid>
  );
};

const kagentAboutCard = (
  <EntitySwitch>
    <EntitySwitch.Case if={isKagentAgent}>
      <KagentAboutCardContent />
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
      <EntityAboutCard variant="gridItem" />
    </Grid>
    <Grid item md={6} xs={12}>
      <EntityCatalogGraphCard variant="gridItem" height={400} />
    </Grid>

    {kagentAboutCard}

    <Grid item md={4} xs={12}>
      <EntityLinksCard />
    </Grid>
    <Grid item md={8} xs={12}>
      <EntityHasSubcomponentsCard variant="gridItem" />
    </Grid>
  </Grid>
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
          <EntityDependsOnComponentsCard variant="gridItem" />
        </Grid>
        <Grid item md={6}>
          <EntityDependsOnResourcesCard variant="gridItem" />
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

    <EntityLayout.Route path="/dependencies" title="Dependencies">
      <Grid container spacing={3} alignItems="stretch">
        <Grid item md={6}>
          <EntityDependsOnComponentsCard variant="gridItem" />
        </Grid>
        <Grid item md={6}>
          <EntityDependsOnResourcesCard variant="gridItem" />
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
          <EntityCatalogGraphCard variant="gridItem" height={400} />
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
          <EntityUserProfileCard variant="gridItem" />
        </Grid>
        <Grid item xs={12} md={6}>
          <EntityOwnershipCard variant="gridItem" />
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
          <EntityGroupProfileCard variant="gridItem" />
        </Grid>
        <Grid item xs={12} md={6}>
          <EntityOwnershipCard variant="gridItem" />
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
          <EntityAboutCard variant="gridItem" />
        </Grid>
        <Grid item md={6} xs={12}>
          <EntityCatalogGraphCard variant="gridItem" height={400} />
        </Grid>
        <Grid item md={4} xs={12}>
          <EntityLinksCard />
        </Grid>
        <Grid item md={8}>
          <EntityHasComponentsCard variant="gridItem" />
        </Grid>
        <Grid item md={6}>
          <EntityHasApisCard variant="gridItem" />
        </Grid>
        <Grid item md={6}>
          <EntityHasResourcesCard variant="gridItem" />
        </Grid>
      </Grid>
    </EntityLayout.Route>
    <EntityLayout.Route path="/diagram" title="Diagram">
      <EntityCatalogGraphCard
        variant="gridItem"
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
          <EntityAboutCard variant="gridItem" />
        </Grid>
        <Grid item md={6} xs={12}>
          <EntityCatalogGraphCard variant="gridItem" height={400} />
        </Grid>
        <Grid item md={6}>
          <EntityHasSystemsCard variant="gridItem" />
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
