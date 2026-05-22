import type { DiscoveryService } from '@backstage/backend-plugin-api';
import { AgentInvocationError } from './errors';

export interface EndpointInfo {
  endpoint: string;
  runtime: string;
  contractVersion: string;
}

/**
 * Resolves a kagent agent name to its A2A endpoint by querying the local
 * catalog API. Validates the agents.platform.ai/* v1 annotation contract.
 *
 * Throws AgentInvocationError on missing or non-conformant entities.
 */
export async function resolveAgent(
  discovery: DiscoveryService,
  name: string,
  logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void },
): Promise<EndpointInfo> {
  const catalogBase = await discovery.getBaseUrl('catalog');
  const url = `${catalogBase}/entities/by-name/component/default/${encodeURIComponent(name)}`;

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
  const annotations: Record<string, string> = entity?.metadata?.annotations ?? {};

  if (entity?.spec?.type !== 'kagent-agent') {
    throw new AgentInvocationError(
      'INVALID_CONTRACT',
      `Entity 'component:default/${name}' is not a kagent-agent (got type: ${entity?.spec?.type}).`,
    );
  }

  const version = annotations['agents.platform.ai/version'];
  if (version !== 'v1') {
    throw new AgentInvocationError(
      'INVALID_CONTRACT',
      `Unsupported contract version: ${version}`,
    );
  }

  const runtime = annotations['agents.platform.ai/runtime'];
  if (runtime !== 'kagent') {
    throw new AgentInvocationError(
      'INVALID_CONTRACT',
      `Unsupported runtime: ${runtime}`,
    );
  }

  const endpoint = annotations['agents.platform.ai/a2a-endpoint'];
  if (!endpoint) {
    throw new AgentInvocationError(
      'INVALID_CONTRACT',
      `Entity 'component:default/${name}' is missing the agents.platform.ai/a2a-endpoint annotation.`,
    );
  }
  try {
    const parsed = new URL(endpoint);
    if (!parsed.hostname.endsWith('.svc.cluster.local')) {
      logger.warn(
        `kagent:agent:invoke — endpoint hostname '${parsed.hostname}' is not cluster-local; allowing for local-testing use case.`,
      );
    }
  } catch {
    throw new AgentInvocationError(
      'INVALID_CONTRACT',
      `Entity 'component:default/${name}' has an invalid a2a-endpoint URL: ${endpoint}`,
    );
  }

  logger.info(
    `kagent:agent:invoke — endpoint=${endpoint} runtime=${runtime}`,
  );

  return { endpoint, runtime, contractVersion: version };
}
