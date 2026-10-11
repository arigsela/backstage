// =============================================================================
// kagent 1.0 — "About this agent" card
// =============================================================================
// Renders a Markdown summary of a kagent 1.0 Agent on the entity Overview tab.
//
// kagent 1.0 (api.kagent.dev/v1alpha3) splits an agent in three:
//   - Agent          — the runnable thing; points at a template and a harness
//   - AgentTemplate  — portable behaviour: model, prompt, tools, skills
//   - Harness        — runtime image and infrastructure policy
// The card reads the Agent and its AgentTemplate (inline `spec.template`, or
// `spec.templateRef`) through the Backstage Kubernetes plugin proxy. The
// Harness is shown by name only. The proxy uses the portal's ServiceAccount,
// so it needs get on agents and agenttemplates in api.kagent.dev
// (backstage-kagent-read in arigsela/kubernetes base-apps/backstage/rbac.yaml).
//
// The entity is ingested from the Agent itself (TeraSky kubernetes-ingestor,
// kubernetesIngestor.components.customWorkloadTypes), so the ingestor's
// kubernetes-resource-name/-namespace annotations name the Agent.

import { useEffect, useState } from 'react';
import { Grid } from '@material-ui/core';
import { InfoCard, MarkdownContent } from '@backstage/core-components';
import { useEntity } from '@backstage/plugin-catalog-react';
import { kubernetesApiRef } from '@backstage/plugin-kubernetes';
import { useApi } from '@backstage/core-plugin-api';
import { Entity } from '@backstage/catalog-model';

const API_BASE = '/apis/api.kagent.dev/v1alpha3';
const CLUSTER = 'homelab';

export const isKagentAgent = (entity: Entity): boolean =>
  entity?.spec?.type === 'kagent-agent';

interface LocalRef {
  name?: string;
}

interface MCPToolBinding {
  server?: { kind?: string; name?: string };
  tools?: string[];
  requireApproval?: boolean;
}

interface SubAgentToolBinding {
  name?: string;
  description?: string;
  templateRef?: LocalRef;
}

export interface KagentAgentTemplateSpec {
  modelConfig?: LocalRef;
  description?: string;
  systemPrompt?: string;
  systemPromptFrom?: { name?: string; key?: string };
  promptTemplate?: { dataSources?: Array<{ name: string; alias?: string }> };
  outputSchema?: unknown;
  outputSchemaFrom?: { name?: string; key?: string };
  tools?: Array<{ mcp?: MCPToolBinding; subAgent?: SubAgentToolBinding }>;
  skills?: Array<{ name: string }>;
  plugins?: Array<{ skills?: string[] }>;
}

interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

export interface KagentAgent {
  spec?: {
    template?: KagentAgentTemplateSpec;
    templateRef?: LocalRef;
    harness?: unknown;
    harnessRef?: LocalRef;
  };
  status?: {
    conditions?: Condition[];
    latestSuccessfulRevision?: string;
    warnings?: string[];
  };
}

const code = (s: string) => `\`${s}\``;

function readiness(agent: KagentAgent): string {
  const ready = agent.status?.conditions?.find(c => c.type === 'Ready');
  if (!ready) return 'unknown (no Ready condition yet)';
  if (ready.status === 'True') return 'Ready';
  const why = [ready.reason, ready.message].filter(Boolean).join(': ');
  return `Not ready${why ? ` — ${why}` : ''}`;
}

/**
 * Builds the card's Markdown. `template` is the resolved AgentTemplate spec
 * (undefined when it could not be read; `templateError` then says why).
 */
export const buildKagentMarkdown = (
  entityName: string,
  agent: KagentAgent,
  template: KagentAgentTemplateSpec | undefined,
  templateError?: string,
): string => {
  const spec = agent.spec ?? {};
  const templateName = spec.templateRef?.name;
  const lines: string[] = [`# ${entityName}`, ''];

  if (template?.description) lines.push(template.description, '');

  if (!template) {
    lines.push(
      '## Behaviour',
      '',
      `_Could not load AgentTemplate ${code(templateName ?? '?')}: ${
        templateError ?? 'unknown error'
      }_`,
    );
  } else {
    lines.push('## Purpose', '');
    if (template.systemPrompt) {
      lines.push(template.systemPrompt);
    } else if (template.systemPromptFrom) {
      lines.push(
        `_Prompt loaded from ConfigMap ${code(
          template.systemPromptFrom.name ?? '?',
        )}, key ${code(template.systemPromptFrom.key ?? '?')}._`,
      );
    } else {
      lines.push('(no system prompt defined)');
    }

    const bindings = template.tools ?? [];
    const mcp = bindings.filter(b => b.mcp).map(b => b.mcp!);
    const subAgents = bindings.filter(b => b.subAgent).map(b => b.subAgent!);

    if (mcp.length > 0) {
      lines.push(
        '',
        '## Tools',
        '',
        '| MCP server | Tools | Approval |',
        '|---|---|---|',
      );
      for (const b of mcp) {
        const tools = b.tools?.length
          ? b.tools.map(code).join(', ')
          : 'all tools on the server';
        lines.push(
          `| ${code(b.server?.name ?? '?')} | ${tools} | ${
            b.requireApproval ? 'required' : '—'
          } |`,
        );
      }
    }

    if (subAgents.length > 0) {
      lines.push(
        '',
        '## Hands off to',
        '',
        'A hand-off passes the conversation to the sub-agent; it does not return.',
        '',
      );
      for (const s of subAgents) {
        lines.push(
          `- **${s.name ?? '?'}** (template ${code(
            s.templateRef?.name ?? '?',
          )}) — ${s.description ?? ''}`,
        );
      }
    }

    const skills = [
      ...(template.skills ?? []).map(s => s.name),
      ...(template.plugins ?? []).flatMap(p => p.skills ?? []),
    ];
    if (skills.length > 0) {
      lines.push('', '## Skills', '', ...skills.map(s => `- ${code(s)}`));
    }
  }

  lines.push('', '## Configuration', '', '| Setting | Value |', '|---|---|');
  lines.push(`| Status | ${readiness(agent)} |`);
  lines.push(
    `| Template | ${
      templateName ? code(templateName) : 'inline in the Agent'
    } |`,
  );
  if (template?.modelConfig?.name) {
    lines.push(`| Model | ${code(template.modelConfig.name)} |`);
  }
  lines.push(
    `| Harness | ${
      spec.harnessRef?.name ? code(spec.harnessRef.name) : 'inline in the Agent'
    } |`,
  );
  if (template) {
    const sources = template.promptTemplate?.dataSources ?? [];
    lines.push(
      `| Prompt template | ${
        sources.length
          ? sources.map(d => code(d.alias ?? d.name)).join(', ')
          : 'not used'
      } |`,
      `| Structured output | ${
        template.outputSchema || template.outputSchemaFrom ? 'yes' : 'no'
      } |`,
    );
  }
  if (agent.status?.latestSuccessfulRevision) {
    lines.push(`| Revision | ${code(agent.status.latestSuccessfulRevision)} |`);
  }

  const warnings = agent.status?.warnings ?? [];
  if (warnings.length > 0) {
    lines.push('', '## Warnings', '', ...warnings.map(w => `- ${w}`));
  }

  lines.push(
    '',
    '## Manage',
    '',
    `- **Edit:** the Agent is \`base-apps/kagent/agents/${entityName}.yaml\` in ` +
      'arigsela/kubernetes; behaviour (model, prompt, tools) lives in its ' +
      `AgentTemplate${
        templateName ? ` ${code(templateName)}` : ''
      } under \`base-apps/kagent/agent-templates/\`. Open a PR.`,
  );

  return lines.join('\n');
};

interface CardState {
  agent?: KagentAgent;
  template?: KagentAgentTemplateSpec;
  templateError?: string;
  error?: string;
}

export const KagentAboutCardContent = () => {
  const { entity } = useEntity();
  const kubernetesApi = useApi(kubernetesApiRef);
  const [state, setState] = useState<CardState | null>(null);

  useEffect(() => {
    const ann = entity.metadata.annotations || {};
    const name =
      ann['terasky.backstage.io/kubernetes-resource-name'] ||
      entity.metadata.name;
    const namespace =
      ann['terasky.backstage.io/kubernetes-resource-namespace'] || 'kagent';

    let cancelled = false;
    const get = async (path: string) => {
      const res = await kubernetesApi.proxy({ clusterName: CLUSTER, path });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json();
    };

    const load = async (): Promise<CardState> => {
      let agent: KagentAgent;
      try {
        agent = await get(`${API_BASE}/namespaces/${namespace}/agents/${name}`);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
      if (agent.spec?.template) {
        return { agent, template: agent.spec.template };
      }
      const ref = agent.spec?.templateRef?.name;
      if (!ref) {
        return { agent, templateError: 'the Agent names no template' };
      }
      try {
        const tpl = await get(
          `${API_BASE}/namespaces/${namespace}/agenttemplates/${ref}`,
        );
        return { agent, template: tpl.spec ?? {} };
      } catch (err) {
        return {
          agent,
          templateError: err instanceof Error ? err.message : String(err),
        };
      }
    };

    load().then(result => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [entity, kubernetesApi]);

  let body;
  if (state === null) {
    body = <em>Loading agent details from cluster…</em>;
  } else if (state.error || !state.agent) {
    body = (
      <em>Could not load agent details: {state.error || 'unknown error'}</em>
    );
  } else {
    body = (
      <MarkdownContent
        content={buildKagentMarkdown(
          entity.metadata.name,
          state.agent,
          state.template,
          state.templateError,
        )}
      />
    );
  }

  return (
    <Grid item xs={12}>
      <InfoCard title="About this agent">{body}</InfoCard>
    </Grid>
  );
};
