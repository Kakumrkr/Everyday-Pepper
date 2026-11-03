import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import type { StorageConfig } from './config.js';
import type { ObjectInfo, ObjectStore, StoredObject } from './object-store.js';

/** Whether an S3 error means "there is nothing there". */
function isNotFound(error: unknown): boolean {
  if (!(error instanceof S3ServiceException)) return false;
  return (
    error.name === 'NoSuchKey' ||
    error.name === 'NotFound' ||
    error.name === 'NoSuchBucket' ||
    error.$metadata.httpStatusCode === 404
  );
}

/**
 * The `ObjectStore` on the S3 API (ADR-0048). Path-style addressing and checksums only where
 * the API requires them, so SeaweedFS, R2 and S3 all accept the same calls; the contract test
 * (`s3.int.test.ts`) runs exactly these calls against SeaweedFS (ADR-0011).
 */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private bucketReady: Promise<void> | null = null;

  constructor(config: StorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
    });
  }

  /**
   * Makes the bucket when it is missing (development and CI); a pilot bucket is made by hand.
   * Checked once per store; a failed check (a store that started after the api) is tried
   * again on the next call, and every write makes sure of it first.
   */
  ensureBucket(): Promise<void> {
    this.bucketReady ??= this.makeBucket().catch((error: unknown) => {
      this.bucketReady = null;
      throw error;
    });
    return this.bucketReady;
  }

  private async makeBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.ensureBucket();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
      }),
    );
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const answer = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (answer.Body === undefined) return null;
      const body = await answer.Body.transformToByteArray();
      return {
        body,
        size: body.byteLength,
        contentType: answer.ContentType ?? 'application/octet-stream',
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const answer = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: answer.ContentLength ?? 0,
        contentType: answer.ContentType ?? 'application/octet-stream',
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(keys: readonly string[]): Promise<void> {
    // One call per key: every S3-compatible server has DeleteObject, not all DeleteObjects.
    await Promise.all(
      keys.map((key) =>
        this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })),
      ),
    );
  }

  /** Closes the client's connections. */
  close(): void {
    this.client.destroy();
  }
}
