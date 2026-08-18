/**
 * The only file in this module that knows S3 exists.
 *
 * Everything downstream depends on the ReportSource interface instead, which
 * is what lets reportStore be tested with a hand-written fake rather than a
 * mocked AWS SDK.
 *
 * READ-ONLY BY CONSTRUCTION: only GetObject and ListObjectsV2 are imported.
 * There is deliberately no write path here to review.
 */
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import type { CveConfig } from './config';

export interface ReportSource {
  getJson(key: string): Promise<unknown>;
  listKeys(prefix: string): Promise<string[]>;
}

export function createS3ReportSource(cfg: CveConfig): ReportSource {
  // Credentials come from the default AWS chain (env vars in the pod),
  // identical to the existing ECRClient actions in modules/scaffolder.
  const client = new S3Client({ region: cfg.region });

  return {
    async getJson(key: string): Promise<unknown> {
      const res = await client.send(
        new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
      );
      if (!res.Body)
        throw new Error(`empty body for s3://${cfg.bucket}/${key}`);
      return JSON.parse(await res.Body.transformToString());
    },

    async listKeys(prefix: string): Promise<string[]> {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const res = await client.send(
          new ListObjectsV2Command({
            Bucket: cfg.bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const o of res.Contents ?? []) {
          if (o.Key) keys.push(o.Key);
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
  };
}
