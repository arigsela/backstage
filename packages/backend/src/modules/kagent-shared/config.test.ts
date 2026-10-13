import { readKagentA2AConfig } from './config';

describe('readKagentA2AConfig', () => {
  const env = process.env;
  afterEach(() => {
    process.env = env;
  });

  it('reads the token file from config, else from KAGENT_TOKEN_FILE', () => {
    const cfg = (values: Record<string, string>) => ({
      getOptionalString: (k: string) => values[k],
    });
    expect(readKagentA2AConfig(cfg({ 'kagent.a2aTokenFile': '/t' })).tokenFile).toBe('/t');
    process.env = { ...env, KAGENT_TOKEN_FILE: '/var/run/kagent/token' };
    expect(readKagentA2AConfig(cfg({})).tokenFile).toBe('/var/run/kagent/token');
    process.env = { ...env };
    delete process.env.KAGENT_TOKEN_FILE;
    expect(readKagentA2AConfig(cfg({})).tokenFile).toBeUndefined();
  });
});
