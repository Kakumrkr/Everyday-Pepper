import { describe, expect, it } from 'vitest';
import { loadStorageConfig } from './config.js';

const ALL = {
  S3_ENDPOINT: 'http://localhost:8333',
  S3_BUCKET: 'pepper-dev',
  S3_ACCESS_KEY_ID: 'pepperdev',
  S3_SECRET_ACCESS_KEY: 'pepper-dev-secret',
};

describe('loadStorageConfig', () => {
  it('is off when nothing is set (empty counts as unset)', () => {
    expect(loadStorageConfig('api', {})).toBeNull();
    expect(loadStorageConfig('api', { S3_ENDPOINT: '', S3_REGION: 'eu-west-1' })).toBeNull();
  });

  it('reads a full set, with the default region', () => {
    expect(loadStorageConfig('api', ALL)).toEqual({
      endpoint: 'http://localhost:8333',
      region: 'us-east-1',
      bucket: 'pepper-dev',
      accessKeyId: 'pepperdev',
      secretAccessKey: 'pepper-dev-secret',
    });
  });

  it('refuses a partial set, naming what is missing and never a value', () => {
    expect(() => loadStorageConfig('api', { ...ALL, S3_SECRET_ACCESS_KEY: '' })).toThrow(
      'Invalid api environment: S3_SECRET_ACCESS_KEY (set all S3_* or none)',
    );
  });

  it('refuses invalid values', () => {
    expect(() => loadStorageConfig('api', { ...ALL, S3_BUCKET: 'Has_Upper' })).toThrow(
      'Invalid api environment: S3_BUCKET',
    );
    expect(() => loadStorageConfig('api', { ...ALL, S3_ENDPOINT: 'ftp://x' })).toThrow(
      'Invalid api environment: S3_ENDPOINT',
    );
  });
});
