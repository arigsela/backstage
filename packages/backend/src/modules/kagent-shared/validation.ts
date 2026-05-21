export interface ValidatedInput {
  name: string;
  prompt: string;
  expectJson?: boolean;
  timeoutMs?: number;
  onError?: 'fail' | 'continue';
}

/**
 * Runtime input validation. Mirrors the contract the action's zod schema
 * advertises, but enforces at call time (zod in createTemplateAction only
 * drives the wizard UI form generator — it doesn't validate at handler call).
 *
 * The `maxTimeoutMs` option lets consumers cap the timeout differently —
 * the scaffolder action allows up to 300_000ms, but the HTTP route caps
 * at 120_000ms because users are waiting interactively.
 */
export function validateInvokeInput(
  raw: unknown,
  opts: { maxTimeoutMs?: number } = {},
): ValidatedInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  const maxTimeoutMs = opts.maxTimeoutMs ?? 300_000;

  if (
    typeof r.name !== 'string' ||
    !/^[a-z][a-z0-9-]{2,38}[a-z0-9]$/.test(r.name)
  ) {
    throw new Error(
      `kagent:agent:invoke: invalid agent name '${String(r.name)}'. Must match ^[a-z][a-z0-9-]{2,38}[a-z0-9]$.`,
    );
  }
  if (
    typeof r.prompt !== 'string' ||
    r.prompt.length < 1 ||
    r.prompt.length > 8000
  ) {
    throw new Error(
      `kagent:agent:invoke: invalid prompt length (${
        typeof r.prompt === 'string' ? r.prompt.length : 'not a string'
      }). Must be 1..8000 chars.`,
    );
  }
  if (r.timeoutMs !== undefined) {
    if (
      typeof r.timeoutMs !== 'number' ||
      !Number.isInteger(r.timeoutMs) ||
      r.timeoutMs < 5000 ||
      r.timeoutMs > maxTimeoutMs
    ) {
      throw new Error(
        `kagent:agent:invoke: invalid timeoutMs ${String(r.timeoutMs)}. Must be an integer in 5000..${maxTimeoutMs}.`,
      );
    }
  }
  if (
    r.onError !== undefined &&
    r.onError !== 'fail' &&
    r.onError !== 'continue'
  ) {
    throw new Error(
      `kagent:agent:invoke: invalid onError '${String(r.onError)}'. Must be 'fail' or 'continue'.`,
    );
  }
  if (r.expectJson !== undefined && typeof r.expectJson !== 'boolean') {
    throw new Error(
      `kagent:agent:invoke: invalid expectJson type (${typeof r.expectJson}). Must be boolean.`,
    );
  }

  return {
    name: r.name,
    prompt: r.prompt,
    expectJson: r.expectJson as boolean | undefined,
    timeoutMs: r.timeoutMs as number | undefined,
    onError: r.onError as 'fail' | 'continue' | undefined,
  };
}
