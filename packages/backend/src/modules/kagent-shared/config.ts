/**
 * The `kagent:` block of app-config, shared by the kagent-suggest route and
 * the kagent:agent:invoke scaffolder action. Both keys are optional; the
 * defaults reach the in-cluster kagent 1.0 controller.
 */
export interface KagentA2AConfig {
  /** Controller base URL; Agents are served at `<base>/agents/<ns>/<name>`. */
  a2aBaseUrl?: string;
  /** X-User-Id the portal calls as (kagent's insecure auth mode, no mesh in front). */
  userId?: string;
  /**
   * Path of a projected service account token (audience `kagent`). When set, every
   * call sends `Authorization: Bearer <token>` and NO X-User-Id: the mesh in front of
   * the controller verifies the token and sets the identity from it
   * (arigsela/kubernetes, callers as principals, 2026-10-13). Read on every call,
   * because the kubelet rotates projected tokens.
   */
  tokenFile?: string;
}

export function readKagentA2AConfig(config?: {
  getOptionalString(key: string): string | undefined;
}): KagentA2AConfig {
  return {
    a2aBaseUrl: config?.getOptionalString('kagent.a2aBaseUrl'),
    userId: config?.getOptionalString('kagent.a2aUserId'),
    tokenFile:
      config?.getOptionalString('kagent.a2aTokenFile') ??
      process.env.KAGENT_TOKEN_FILE ??
      undefined,
  };
}
