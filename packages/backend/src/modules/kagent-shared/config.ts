/**
 * The `kagent:` block of app-config, shared by the kagent-suggest route and
 * the kagent:agent:invoke scaffolder action. Both keys are optional; the
 * defaults reach the in-cluster kagent 1.0 controller.
 */
export interface KagentA2AConfig {
  /** Controller base URL; Agents are served at `<base>/agents/<ns>/<name>`. */
  a2aBaseUrl?: string;
  /** X-User-Id the portal calls as (kagent's insecure auth mode). */
  userId?: string;
}

export function readKagentA2AConfig(config?: {
  getOptionalString(key: string): string | undefined;
}): KagentA2AConfig {
  return {
    a2aBaseUrl: config?.getOptionalString('kagent.a2aBaseUrl'),
    userId: config?.getOptionalString('kagent.a2aUserId'),
  };
}
