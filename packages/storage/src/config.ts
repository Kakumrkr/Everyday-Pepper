import { z } from 'zod';

/** Where the S3-compatible store is and how to sign in to it. Never log it. */
export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const StorageEnvSchema = z.object({
  /** The S3 API's base URL (SeaweedFS `http://localhost:8333` in development). */
  S3_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  S3_REGION: z.string().min(1).max(64).default('us-east-1'),
  /** S3 bucket naming: 3–63 lowercase letters, digits, dots and hyphens. */
  S3_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .optional(),
  S3_ACCESS_KEY_ID: z.string().min(3).max(128).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(8).max(256).optional(),
});

const REQUIRED = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;

/**
 * Reads the object store's configuration (ADR-0048): all of `S3_ENDPOINT`, `S3_BUCKET`,
 * `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` set, or none (`null`: storage is off, photos
 * can't be added). An empty variable means unset; a partial or invalid set stops the process.
 */
export function loadStorageConfig(label: string, env: NodeJS.ProcessEnv): StorageConfig | null {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const result = StorageEnvSchema.safeParse(present);
  if (!result.success) {
    const invalid = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid ${label} environment: ${invalid.join(', ')}`);
  }
  const parsed = result.data;
  const missing = REQUIRED.filter((name) => parsed[name] === undefined);
  if (missing.length === REQUIRED.length) return null;
  if (
    missing.length > 0 ||
    parsed.S3_ENDPOINT === undefined ||
    parsed.S3_BUCKET === undefined ||
    parsed.S3_ACCESS_KEY_ID === undefined ||
    parsed.S3_SECRET_ACCESS_KEY === undefined
  ) {
    throw new Error(`Invalid ${label} environment: ${missing.join(', ')} (set all S3_* or none)`);
  }
  return {
    endpoint: parsed.S3_ENDPOINT,
    region: parsed.S3_REGION,
    bucket: parsed.S3_BUCKET,
    accessKeyId: parsed.S3_ACCESS_KEY_ID,
    secretAccessKey: parsed.S3_SECRET_ACCESS_KEY,
  };
}
