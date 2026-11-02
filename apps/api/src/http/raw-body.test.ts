import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readUpload } from './raw-body.js';

function upload(chunks: Buffer[], headers: Record<string, string>): IncomingMessage {
  const stream = Readable.from(chunks) as unknown as IncomingMessage;
  stream.headers = headers;
  return stream;
}

describe('readUpload (ADR-0048)', () => {
  it('reads an image body whole', async () => {
    const body = await readUpload(
      upload([Buffer.from([1, 2]), Buffer.from([3])], { 'content-type': 'image/jpeg' }),
      10,
    );
    expect([...body]).toEqual([1, 2, 3]);
  });

  it('stops as soon as the body grows past the limit, whatever its length says', async () => {
    const request = upload([Buffer.alloc(6), Buffer.alloc(6)], {
      'content-type': 'application/octet-stream',
      'content-length': '4',
    });
    await expect(readUpload(request, 10)).rejects.toMatchObject({ status: 413 });
  });

  it('refuses a declared length over the limit before reading', async () => {
    const request = upload([Buffer.alloc(1)], {
      'content-type': 'image/png',
      'content-length': '11',
    });
    await expect(readUpload(request, 10)).rejects.toMatchObject({ status: 413 });
  });

  it('refuses a body sent as anything but an image', async () => {
    for (const type of ['application/json', 'text/html', 'multipart/form-data; boundary=x', '']) {
      await expect(
        readUpload(upload([Buffer.alloc(1)], { 'content-type': type }), 10),
      ).rejects.toMatchObject({ status: 415 });
    }
  });
});
