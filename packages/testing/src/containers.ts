import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { composeImage } from './compose.js';

/** A disposable container started for a test file. */
export interface TestService {
  /** Connection string, including the throwaway credentials. */
  readonly url: string;
  stop(): Promise<void>;
}

/** How long a stop waits, at most, for Docker to say a killed container has exited. */
export const STOP_WAIT = { tries: 20, pauseMs: 500 } as const;

/** Docker's refusal to remove a container it still reports as running (HTTP 409). */
function isStillRunning(error: unknown): boolean {
  return error instanceof Error && /container is running/i.test(error.message);
}

/**
 * Stops and removes a container. Testcontainers kills it (`timeout: 0`) and removes it at once;
 * on a loaded CI runner Docker can still report the killed container as running for a moment,
 * and the removal is refused with 409 (S78's CI: the suite failed after all its tests passed).
 * That one refusal waits for Docker to catch up and stops again (already stopped: only the
 * removal), at most `STOP_WAIT`; any other error, or one that lasts, is thrown.
 */
export async function stopContainer(
  container: Pick<StartedTestContainer, 'stop'>,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await container.stop();
      return;
    } catch (error) {
      if (!isStillRunning(error) || attempt >= STOP_WAIT.tries) throw error;
      await pause(STOP_WAIT.pauseMs);
    }
  }
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
    stop: () => stopContainer(container),
  };
}

/** Redis, the Compose image, on a random host port. */
export async function startRedis(): Promise<TestService> {
  const container = await new RedisContainer(composeImage('redis')).start();
  return {
    url: container.getConnectionUrl(),
    stop: () => stopContainer(container),
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
    stop: () => stopContainer(container),
  };
}

/** SeaweedFS's S3 API (ADR-0011, ADR-0048) with throwaway keys, on a random host port. */
export interface TestObjectStorage {
  /** `http://host:port`. */
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  stop(): Promise<void>;
}

/**
 * SeaweedFS's settings, as in docker-compose.yml (`compose.test.ts` checks they match): small
 * volumes grown one at a time, and an explicit maximum. Left to size itself from the free
 * disk, a runner with less disk gets too few volumes and a new bucket's first write fails with
 * InternalError (S47.2).
 */
export const SEAWEEDFS_COMMAND = [
  'server',
  '-s3',
  '-dir=/data',
  '-ip.bind=0.0.0.0',
  '-master.volumeSizeLimitMB=64',
  '-volume.max=100',
] as const;
export const SEAWEEDFS_ENV = { WEED_MASTER_VOLUME_GROWTH_COPY_1: '1' } as const;

/** SeaweedFS, the Compose image, accepting signed requests with its keys only. */
export async function startSeaweedFs(): Promise<TestObjectStorage> {
  const accessKeyId = 'pepper_test';
  const secretAccessKey = 'pepper-test-secret';
  const container = await new GenericContainer(composeImage('seaweedfs'))
    .withCommand([...SEAWEEDFS_COMMAND])
    .withEnvironment({
      ...SEAWEEDFS_ENV,
      AWS_ACCESS_KEY_ID: accessKeyId,
      AWS_SECRET_ACCESS_KEY: secretAccessKey,
    })
    .withExposedPorts(8333, 9333)
    // Ready once it can store (as Compose's healthcheck): S3's /healthz answers before the
    // volume server may grow volumes, when a first write fails with InternalError.
    .withWaitStrategy(
      Wait.forAll([
        Wait.forHttp('/healthz', 8333),
        Wait.forHttp('/dir/assign', 9333).forResponsePredicate((body) => body.includes('"fid"')),
      ]).withStartupTimeout(180_000),
    )
    .start();
  return {
    endpoint: `http://${container.getHost()}:${String(container.getMappedPort(8333))}`,
    accessKeyId,
    secretAccessKey,
    stop: () => stopContainer(container),
  };
}
