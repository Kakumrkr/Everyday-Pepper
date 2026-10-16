import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
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
    .withDatabase('floty_test')
    .withUsername('floty_test')
    .withPassword('floty_test')
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
