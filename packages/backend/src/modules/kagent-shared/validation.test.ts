import { validateInvokeInput } from './validation';

describe('validateInvokeInput', () => {
  it('rejects empty prompt', () => {
    expect(() =>
      validateInvokeInput({ name: 'foo-agent', prompt: '' }),
    ).toThrow(/invalid prompt length/);
  });

  it('rejects prompt over 8000 chars', () => {
    expect(() =>
      validateInvokeInput({ name: 'foo-agent', prompt: 'x'.repeat(8001) }),
    ).toThrow(/invalid prompt length/);
  });

  it('rejects invalid agent name', () => {
    expect(() =>
      validateInvokeInput({ name: 'INVALID_NAME', prompt: 'hello' }),
    ).toThrow(/invalid agent name/);
  });

  it('rejects timeoutMs below 5000', () => {
    expect(() =>
      validateInvokeInput({ name: 'foo-agent', prompt: 'hello', timeoutMs: 1000 }),
    ).toThrow(/invalid timeoutMs/);
  });

  it('rejects timeoutMs above maxTimeoutMs', () => {
    // Default cap is 300_000; passing 999_999 must fail.
    expect(() =>
      validateInvokeInput({ name: 'foo-agent', prompt: 'hello', timeoutMs: 999999 }),
    ).toThrow(/invalid timeoutMs/);
    // Lower cap of 120_000: 250_000 must also fail under the route's cap.
    expect(() =>
      validateInvokeInput(
        { name: 'foo-agent', prompt: 'hello', timeoutMs: 250000 },
        { maxTimeoutMs: 120000 },
      ),
    ).toThrow(/invalid timeoutMs/);
  });
});
