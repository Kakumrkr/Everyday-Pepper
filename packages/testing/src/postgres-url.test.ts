import { describe, expect, it } from 'vitest';
import { postgresUrlAs } from './postgres-url.js';

describe('postgresUrlAs', () => {
  it('replaces user and password, keeping host, port and database', () => {
    expect(postgresUrlAs('postgres://admin:pw@127.0.0.1:5432/floty', 'svc', 'p@ss/w:rd')).toBe(
      'postgres://svc:p%40ss%2Fw%3Ard@127.0.0.1:5432/floty',
    );
  });
});
