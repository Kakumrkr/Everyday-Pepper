import { z } from 'zod';

/** A Postgres connection string (`postgres://` or `postgresql://`). Carries credentials. */
export const DatabaseUrlSchema = z.url({ protocol: /^postgres(ql)?$/ });
/** A Redis connection string (`redis://` or `rediss://`). May carry credentials. */
export const RedisUrlSchema = z.url({ protocol: /^rediss?$/ });
/** A TCP port, coerced from the environment string. */
export const PortSchema = z.coerce.number().int().min(1).max(65_535);

/**
 * Parses `env` with `schema`. The error names the invalid variables but never echoes their
 * values (connection strings carry credentials). Minimal on purpose: S5 adds the shared config.
 */
export function loadEnv<T extends z.ZodType>(
  label: string,
  schema: T,
  env: NodeJS.ProcessEnv,
): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const invalid = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid ${label} environment: ${invalid.join(', ')}`);
  }
  return result.data;
}
