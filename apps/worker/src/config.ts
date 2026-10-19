import { loadServiceConfig, type ServiceConfig } from '@pepper/runtime/instrument';

/**
 * The worker's configuration. Read by `instrument.ts` (before anything else loads) and by
 * `main.ts`. Never log it: connection strings and the Sentry DSN carry credentials.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv): ServiceConfig {
  return loadServiceConfig('worker', env, { port: 4100 });
}
