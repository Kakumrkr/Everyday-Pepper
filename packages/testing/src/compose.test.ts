import { describe, expect, it } from 'vitest';
import { composeImage } from './compose.js';

describe('composeImage', () => {
  it('reads the pinned images from the repository docker-compose.yml', () => {
    expect(composeImage('postgres')).toMatch(/^pgvector\/pgvector:pg\d+@sha256:[0-9a-f]{64}$/);
    expect(composeImage('redis')).toMatch(/^redis:[\w.-]+@sha256:[0-9a-f]{64}$/);
    expect(composeImage('seaweedfs')).toMatch(/^chrislusf\/seaweedfs:[\w.-]+@sha256:[0-9a-f]{64}$/);
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
