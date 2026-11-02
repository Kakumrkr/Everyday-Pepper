import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { composeImage } from './compose.js';
import { SEAWEEDFS_COMMAND, SEAWEEDFS_ENV } from './containers.js';

describe('composeImage', () => {
  it('reads the pinned images from the repository docker-compose.yml', () => {
    expect(composeImage('postgres')).toMatch(/^pgvector\/pgvector:pg\d+@sha256:[0-9a-f]{64}$/);
    expect(composeImage('redis')).toMatch(/^redis:[\w.-]+@sha256:[0-9a-f]{64}$/);
    expect(composeImage('seaweedfs')).toMatch(/^chrislusf\/seaweedfs:[\w.-]+@sha256:[0-9a-f]{64}$/);
  });

  it('runs SeaweedFS with the same settings as the tests do (S47.2)', () => {
    const compose = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
    const service = /^ {2}seaweedfs:\n((?: {4}.*\n|\s*\n)*)/m.exec(compose)?.[1] ?? '';
    for (const arg of SEAWEEDFS_COMMAND) expect(service).toContain(`'${arg}'`);
    for (const [key, value] of Object.entries(SEAWEEDFS_ENV)) {
      expect(service).toContain(`${key}: '${value}'`);
    }
  });

  it('finds the image line among other keys of the service only', () => {
    const compose = [
      'services:',
      '  web:',
      '    build: .',
      '    image: web:dev',
      '  redis:',
      '    command: [redis-server]',
      '    image: redis:8',
      '',
    ].join('\n');
    expect(composeImage('redis', compose)).toBe('redis:8');
    expect(() => composeImage('postgres', compose)).toThrow(
      'No image for service "postgres" in docker-compose.yml',
    );
  });
});
