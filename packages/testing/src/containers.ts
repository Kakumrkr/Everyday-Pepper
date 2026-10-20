import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { GenericContainer, Wait } from 'testcontainers';
import { composeImage } from './compose.js';

/** A disposable container started for a test file. */
export interface TestService {
  /** Connection string, including the throwaway credentials. */
  readonly url: string;
  stop(): Promise<void>;
}

/** Postgres with pgvector, the Compose image, on a random host port. */
export async function startPostgres(): Promise<TestService> {
  const container = await new PostgreSqlContainer(composeImage('postgres'))
    .withDatabase('pepper_test')
    .withUsername('pepper_test')
    .withPassword('pepper_test')
    .start();
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}

/** Redis, the Compose image, on a random host port. */
export async function startRedis(): Promise<TestService> {
  const container = await new RedisContainer(composeImage('redis')).start();
  return {
    url: container.getConnectionUrl(),
    stop: async () => {
      await container.stop();
    },
  };
}

/** Mailpit (a fake inbox), the Compose image: SMTP and its HTTP API on random host ports. */
export interface TestMailpit {
  /** `smtp://host:port`. */
  readonly smtpUrl: string;
  /** Base URL of the HTTP API, e.g. `${apiUrl}/api/v1/messages`. */
  readonly apiUrl: string;
  stop(): Promise<void>;
}

/** Mailpit with its chaos API on, so a test can make the SMTP server refuse mail. */
export async function startMailpit(): Promise<TestMailpit> {
  const container = await new GenericContainer(composeImage('mailpit'))
    .withExposedPorts(1025, 8025)
    .withEnvironment({ MP_ENABLE_CHAOS: 'true' })
    .withWaitStrategy(Wait.forHttp('/readyz', 8025))
    .start();
  const host = container.getHost();
  return {
    smtpUrl: `smtp://${host}:${String(container.getMappedPort(1025))}`,
    apiUrl: `http://${host}:${String(container.getMappedPort(8025))}`,
    stop: async () => {
      await container.stop();
    },
  };
}
