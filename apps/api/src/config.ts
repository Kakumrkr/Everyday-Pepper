import { loadServiceConfig, type ServiceConfig } from '@floty/runtime/instrument';

/**
 * The api's configuration. Read by `instrument.ts` (before anything else loads) and by
 * `main.ts`. Never log it: connection strings and the Sentry DSN carry credentials.
 */
export function loadApiConfig(env: NodeJS.ProcessEnv): ServiceConfig {
  return loadServiceConfig('api', env, { port: 4000 });
}
