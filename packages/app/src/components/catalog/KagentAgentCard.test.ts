import {
  buildKagentMarkdown,
  isKagentAgent,
  KagentAgent,
  KagentAgentTemplateSpec,
} from './KagentAgentCard';

// Shapes follow kagent v1.0.0-alpha11 go/api/v1alpha3/{agent,agenttemplate}_types.go.
const agent: KagentAgent = {
  spec: {
    templateRef: { name: 'homelab-knowledge' },
    harnessRef: { name: 'kagent-go' },
  },
  status: {
    latestSuccessfulRevision: 'rev-3',
    conditions: [{ type: 'Ready', status: 'True', reason: 'Prepared' }],
  },
};

const template: KagentAgentTemplateSpec = {
  description: 'Answers questions about the homelab.',
  modelConfig: { name: 'anthropic-claude-sonnet-5-5' },
  systemPrompt: 'You answer from the repo docs.',
  tools: [
    {
      mcp: {
        server: { kind: 'RemoteMCPServer', name: 'agent-docs-mcp' },
        tools: ['read_doc', 'search_docs'],
      },
    },
    {
      mcp: {
        server: { kind: 'RemoteMCPServer', name: 'kagent-tool-server' },
        tools: ['k8s_delete_resource'],
        requireApproval: true,
      },
    },
    {
      subAgent: {
        name: 'k8s',
        description: 'Cluster operations',
        templateRef: { name: 'k8s-agent' },
      },
    },
  ],
  skills: [{ name: 'triage' }],
};

describe('buildKagentMarkdown', () => {
  it('renders purpose, tool bindings, hand-offs and configuration', () => {
    const md = buildKagentMarkdown('homelab-knowledge', agent, template);

    expect(md).toContain('Answers questions about the homelab.');
    expect(md).toContain('You answer from the repo docs.');
    expect(md).toContain(
      '| `agent-docs-mcp` | `read_doc`, `search_docs` | — |',
    );
    expect(md).toContain(
      '| `kagent-tool-server` | `k8s_delete_resource` | required |',
    );
    expect(md).toContain(
      '- **k8s** (template `k8s-agent`) — Cluster operations',
    );
    expect(md).toContain('- `triage`');
    expect(md).toContain('| Status | Ready |');
    expect(md).toContain('| Template | `homelab-knowledge` |');
    expect(md).toContain('| Model | `anthropic-claude-sonnet-5-5` |');
    expect(md).toContain('| Harness | `kagent-go` |');
    expect(md).toContain('| Revision | `rev-3` |');
    expect(md).toContain('base-apps/kagent/agents/homelab-knowledge.yaml');
  });

  it('says when a binding exposes the whole server', () => {
    const md = buildKagentMarkdown('a', agent, {
      tools: [{ mcp: { server: { name: 'srv' } } }],
    });
    expect(md).toContain('| `srv` | all tools on the server | — |');
  });

  it('points at the ConfigMap when the prompt is external', () => {
    const md = buildKagentMarkdown('a', agent, {
      systemPromptFrom: { name: 'prompts', key: 'hk' },
    });
    expect(md).toContain('ConfigMap `prompts`, key `hk`');
  });

  it('still renders the Agent when its template cannot be read', () => {
    const notReady: KagentAgent = {
      ...agent,
      status: {
        conditions: [
          {
            type: 'Ready',
            status: 'False',
            reason: 'ResolvedRefs',
            message: 'template missing',
          },
        ],
        warnings: ['tool selection not enforced'],
      },
    };
    const md = buildKagentMarkdown('a', notReady, undefined, '404 Not Found');

    expect(md).toContain(
      'Could not load AgentTemplate `homelab-knowledge`: 404 Not Found',
    );
    expect(md).toContain(
      '| Status | Not ready — ResolvedRefs: template missing |',
    );
    expect(md).toContain('- tool selection not enforced');
    expect(md).not.toContain('| Model |');
  });
});

describe('isKagentAgent', () => {
  it('matches the kagent-agent component type only', () => {
    const entity = (type: string) =>
      ({
        apiVersion: 'v1',
        kind: 'Component',
        metadata: { name: 'x' },
        spec: { type },
      } as any);
    expect(isKagentAgent(entity('kagent-agent'))).toBe(true);
    expect(isKagentAgent(entity('service'))).toBe(false);
  });
});
