import { DatabaseUrlSchema, loadEnv, PortSchema, RedisUrlSchema } from '@floty/runtime';
import { z } from 'zod';

const WorkerEnvSchema = z.object({
  PORT: PortSchema.default(4100),
  DATABASE_URL: DatabaseUrlSchema,
  REDIS_URL: RedisUrlSchema,
});
export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;

/** The worker's environment. Never log the result: connection strings carry credentials. */
export function loadWorkerEnv(env: NodeJS.ProcessEnv): WorkerEnv {
  return loadEnv('worker', WorkerEnvSchema, env);
}
