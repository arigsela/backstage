/**
 * Reads the `cve:` block from app-config into a typed object.
 * Every field except `bucket` has a default, so local dev needs one line.
 */
import type { Config } from '@backstage/config';

export interface CveConfig {
  bucket: string;
  region: string;
  /** Always normalized to end with '/'. */
  prefix: string;
  cacheTtlMs: number;
  historyWeeks: number;
}

export function readCveConfig(root: Config): CveConfig {
  const c = root.getConfig('cve');
  const prefix = c.getOptionalString('prefix') ?? 'cve-reports/';
  return {
    bucket: c.getString('bucket'),
    region: c.getOptionalString('region') ?? 'us-east-1',
    prefix: prefix.endsWith('/') ? prefix : `${prefix}/`,
    cacheTtlMs: (c.getOptionalNumber('cacheTtlMinutes') ?? 60) * 60_000,
    historyWeeks: c.getOptionalNumber('historyWeeks') ?? 8,
  };
}
