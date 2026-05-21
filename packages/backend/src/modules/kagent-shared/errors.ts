/**
 * Typed error class for all kagent invocation failures. The `code` field is
 * the contract between the resolver/invoker and the consumers (the scaffolder
 * action and the kagent-suggest HTTP route).
 */
export class AgentInvocationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'AgentInvocationError';
  }
}
