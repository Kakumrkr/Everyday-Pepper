import { Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startMailpit,
  startPostgres,
  startRedis,
  type TestMailpit,
  type TestService,
} from './containers.js';

/** Resolves when something accepts TCP connections at the URL's host and port. */
function reachable(url: string): Promise<void> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.once('error', reject);
    socket.connect(Number(port), hostname, () => {
      socket.destroy();
      resolve();
    });
  });
}

describe('test containers', () => {
  let postgres: TestService | undefined;
  let redis: TestService | undefined;

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
  });

  afterAll(async () => {
    await Promise.all([postgres?.stop(), redis?.stop()]);
  });

  it('start Postgres and Redis on reachable random ports', async () => {
    expect(postgres?.url).toMatch(
      /^postgres(ql)?:\/\/pepper_test:pepper_test@[^/]+:\d+\/pepper_test$/,
    );
    expect(redis?.url).toMatch(/^redis:\/\/[^/]+:\d+$/);
    await expect(reachable(postgres?.url ?? '')).resolves.toBeUndefined();
    await expect(reachable(redis?.url ?? '')).resolves.toBeUndefined();
  });
});

describe('Mailpit test container', () => {
  let mailpit: TestMailpit | undefined;

  beforeAll(async () => {
    mailpit = await startMailpit();
  });

  afterAll(async () => {
    await mailpit?.stop();
  });

  it('accepts SMTP and answers its API, with chaos enabled', async () => {
    await expect(reachable(mailpit?.smtpUrl ?? '')).resolves.toBeUndefined();
    const messages = await fetch(`${mailpit?.apiUrl ?? ''}/api/v1/messages`);
    expect(messages.status).toBe(200);
    const chaos = await fetch(`${mailpit?.apiUrl ?? ''}/api/v1/chaos`);
    expect(chaos.status).toBe(200);
  });
});
