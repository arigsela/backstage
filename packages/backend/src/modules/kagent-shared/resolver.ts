import type { DiscoveryService } from '@backstage/backend-plugin-api';
import { AgentInvocationError } from './errors';

/**
 * In-cluster base URL of the kagent 1.0 controller, whose A2A gateway serves
 * every Agent at `/agents/<namespace>/<name>` (port 8083 also carries the
 * controller's gRPC API and /mcp). Override with `kagent.a2aBaseUrl`.
 */
export const DEFAULT_A2A_BASE_URL =
  'http://kagent-controller.kagent.svc.cluster.local:8083';

export interface EndpointInfo {
  /** Full A2A JSON-RPC URL: `<base>/agents/<namespace>/<name>`. */
  endpoint: string;
  runtime: string;
  namespace: string;
  agent: string;
}

// Set by TeraSky's kubernetes-ingestor on every ingested entity: they name the
// Kubernetes object the entity was built from (kagent Agents are ingested as
// a custom workload type, see kubernetesIngestor.components.customWorkloadTypes).
const RESOURCE_KIND = 'terasky.backstage.io/kubernetes-resource-kind';
const RESOURCE_API_VERSION =
  'terasky.backstage.io/kubernetes-resource-api-version';
const RESOURCE_NAME = 'terasky.backstage.io/kubernetes-resource-name';
const RESOURCE_NAMESPACE = 'terasky.backstage.io/kubernetes-resource-namespace';

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

/**
 * Resolves a catalog agent name to its kagent 1.0 A2A endpoint.
 *
 * The catalog is still the gate: only entities of type `kagent-agent` that
 * were ingested from an `api.kagent.dev` Agent resolve, so the portal can
 * reach exactly the agents that opted into the catalog. The endpoint itself
 * is derived from the controller URL — kagent 1.0 has no per-agent Service,
 * and the old `agents.platform.ai/a2a-endpoint` annotation contract was
 * removed from the Agent manifests on 2026-07-14.
 *
 * Throws AgentInvocationError on missing or non-conformant entities.
 */
export async function resolveAgent(
  discovery: DiscoveryService,
  name: string,
  logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void },
  opts: { a2aBaseUrl?: string } = {},
): Promise<EndpointInfo> {
  const catalogBase = await discovery.getBaseUrl('catalog');
  const url = `${catalogBase}/entities/by-name/component/default/${encodeURIComponent(
    name,
  )}`;

  logger.info(`kagent:agent:invoke — resolving '${name}'`);

  const response = await fetch(url);

  if (response.status === 404) {
    throw new AgentInvocationError(
      'AGENT_NOT_FOUND',
      `No catalog entity 'component:default/${name}'. Has the kagent Agent been ingested yet?`,
    );
  }
  if (!response.ok) {
    throw new AgentInvocationError(
      'INVALID_CONTRACT',
      `Catalog returned HTTP ${response.status} for '${name}'.`,
    );
  }

  const entity: any = await response.json();
  const annotations: Record<string, string> =
    entity?.metadata?.annotations ?? {};

  if (entity?.spec?.type !== 'kagent-agent') {
    throw new AgentInvocationError(
      'INVALID_CONTRACT',
      `Entity 'component:default/${name}' is not a kagent-agent (got type: ${entity?.spec?.type}).`,
    );
  }

  const kind = annotations[RESOURCE_KIND];
  const apiVersion = annotations[RESOURCE_API_VERSION] ?? '';
  if (kind !== 'Agent' || !apiVersion.startsWith('api.kagent.dev/')) {
    throw new AgentInvocationError(
      'INVALID_CONTRACT',
      `Entity 'component:default/${name}' was ingested from ${
        kind ?? 'an unknown kind'
      } ` +
        `${
          apiVersion || '(no api version)'
        }, not a kagent 1.0 Agent (api.kagent.dev).`,
    );
  }

  const agent = annotations[RESOURCE_NAME] || entity?.metadata?.name;
  const namespace =
    annotations[RESOURCE_NAMESPACE] ||
    annotations['backstage.io/kubernetes-namespace'];
  if (!DNS_LABEL.test(namespace ?? '') || !DNS_SUBDOMAIN.test(agent ?? '')) {
    throw new AgentInvocationError(
      'INVALID_CONTRACT',
      `Entity 'component:default/${name}' does not name a valid Agent (namespace '${namespace}', name '${agent}').`,
    );
  }

  const base = (opts.a2aBaseUrl || DEFAULT_A2A_BASE_URL).replace(/\/+$/, '');
  const endpoint = `${base}/agents/${namespace}/${agent}`;

  logger.info(`kagent:agent:invoke — endpoint=${endpoint}`);

  return { endpoint, runtime: 'kagent', namespace, agent };
}
