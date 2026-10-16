import { DatabaseUrlSchema, loadEnv, PortSchema, RedisUrlSchema } from '@floty/runtime';
import { z } from 'zod';

const ApiEnvSchema = z.object({
  PORT: PortSchema.default(4000),
  DATABASE_URL: DatabaseUrlSchema,
  REDIS_URL: RedisUrlSchema,
});
export type ApiEnv = z.infer<typeof ApiEnvSchema>;

/** The api's environment. Never log the result: connection strings carry credentials. */
export function loadApiEnv(env: NodeJS.ProcessEnv): ApiEnv {
  return loadEnv('api', ApiEnvSchema, env);
}
