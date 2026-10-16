import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { freePort, recordingServer } from './http.js';

describe('recordingServer', () => {
  it('records plain and gzip bodies and answers 200', async () => {
    const server = await recordingServer();
    try {
      const plain = await fetch(`${server.url}/a?x=1`, { method: 'POST', body: 'hello' });
      await fetch(`${server.url}/b`, {
        method: 'PUT',
        headers: { 'content-encoding': 'gzip' },
        body: gzipSync('zipped'),
      });

      expect(plain.status).toBe(200);
      expect(server.requests).toEqual([
        { method: 'POST', path: '/a?x=1', body: 'hello' },
        { method: 'PUT', path: '/b', body: 'zipped' },
      ]);
    } finally {
      await server.close();
    }
  });
});

describe('freePort', () => {
  it('returns a usable port', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65_536);
  });
});
