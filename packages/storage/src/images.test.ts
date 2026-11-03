import { crc32, deflateSync } from 'node:zlib';
import sharp, { type Sharp } from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  ImageRejectedError,
  MAX_PHOTO_BYTES,
  processImage,
  solidColorPhoto,
  variantWidths,
  type ImageRejection,
  type PhotoKind,
} from './images.js';

const background = { r: 200, g: 120, b: 80 };

function image(width: number, height: number): Sharp {
  return sharp({ create: { width, height, channels: 3, background } });
}

/** A PNG whose IHDR claims `width`×`height` (8-bit RGB), with one byte of image data: no pixels. */
function pngHeaderOnly(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.byteLength);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // bit depth 8, color type RGB, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(1))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function rejection(input: Uint8Array, kind: PhotoKind): Promise<ImageRejection> {
  const error: unknown = await processImage(input, kind).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ImageRejectedError);
  return (error as ImageRejectedError).reason;
}

describe('variantWidths', () => {
  it('keeps every target narrower than the image and caps the widest at its width', () => {
    expect(variantWidths(3000, [320, 640, 1280])).toEqual([320, 640, 1280]);
    expect(variantWidths(1000, [320, 640, 1280])).toEqual([320, 640, 1000]);
    expect(variantWidths(600, [640, 1280, 1920])).toEqual([600]);
    expect(variantWidths(640, [640, 1280])).toEqual([640]);
  });
});

describe('processImage (AC-W8-10)', () => {
  it('remakes a JPEG as WebP at the kind’s widths, never enlarged', async () => {
    const result = await processImage(await image(1000, 700).jpeg().toBuffer(), 'gallery');
    expect(result).toMatchObject({ width: 1000, height: 700 });
    expect(result.variants.map((v) => [v.width, v.height])).toEqual([
      [320, 224],
      [640, 448],
      [1000, 700],
    ]);
    for (const variant of result.variants) {
      expect((await sharp(variant.data).metadata()).format).toBe('webp');
    }
  });

  it('accepts PNG and WebP, and a small logo', async () => {
    const png = await processImage(await image(300, 200).png().toBuffer(), 'logo');
    expect(png.variants.map((v) => v.width)).toEqual([128, 256]);
    const webp = await processImage(await image(700, 700).webp().toBuffer(), 'cover');
    expect(webp.variants.map((v) => v.width)).toEqual([640, 700]);
  });

  it('turns a photo upright and strips its metadata, location included', async () => {
    const tagged = await image(900, 600)
      .jpeg()
      .withExif({
        IFD0: { Make: 'PepperCam' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '40/1 44/1 0/1' },
      })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const before = await sharp(tagged).metadata();
    expect(before.orientation).toBe(6);
    expect(before.exif).toBeDefined();
    const result = await processImage(tagged, 'gallery');
    // Orientation 6 is a quarter turn: 900×600 stored is 600×900 upright.
    expect(result).toMatchObject({ width: 600, height: 900 });
    const variant = result.variants.at(-1);
    expect(variant).toMatchObject({ width: 600, height: 900 });
    const after = await sharp(variant?.data).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(after.orientation).toBeUndefined();
  });

  it('decides the type by content, not by name or label', async () => {
    const gif = await image(800, 800).gif().toBuffer();
    expect(await rejection(gif, 'gallery')).toBe('unsupported_type');
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800"/></svg>',
    );
    expect(await rejection(svg, 'gallery')).toBe('unsupported_type');
    expect(await rejection(Buffer.from('<html>not a photo</html>'), 'gallery')).toBe('unreadable');
    expect(await rejection(new Uint8Array(0), 'logo')).toBe('unreadable');
  });

  it('refuses HEIC with its own reason', async () => {
    // HEIF with AV1 (the encoder sharp ships); libvips reports HEIC and AVIF alike as HEIF.
    const heic = await image(800, 800).heif({ compression: 'av1' }).toBuffer();
    expect(await rejection(heic, 'gallery')).toBe('heic');
  });

  it('refuses files over 10 MB before reading them', async () => {
    expect(await rejection(new Uint8Array(MAX_PHOTO_BYTES + 1), 'gallery')).toBe('too_large');
  });

  it('refuses too many pixels from the header alone (decompression bombs)', async () => {
    // A PNG that says 8000×6000 (48 MP) in its header and carries no pixels at all: refused
    // from the header, without decoding (or, in the test, making 48 MP first).
    const bomb = pngHeaderOnly(8000, 6000);
    expect(bomb.byteLength).toBeLessThan(100);
    expect(await rejection(bomb, 'gallery')).toBe('too_many_pixels');
  });

  it('refuses photos under the kind’s short side', async () => {
    expect(await rejection(await image(127, 400).png().toBuffer(), 'logo')).toBe('too_small');
    expect(await rejection(await image(1200, 599).jpeg().toBuffer(), 'cover')).toBe('too_small');
    expect(await rejection(await image(599, 1200).jpeg().toBuffer(), 'gallery')).toBe('too_small');
  });

  it('refuses shapes longer than 4:1', async () => {
    expect(await rejection(await image(2401, 600).jpeg().toBuffer(), 'cover')).toBe('bad_shape');
    await expect(
      processImage(await image(2400, 600).jpeg().toBuffer(), 'cover'),
    ).resolves.toBeDefined();
  });

  it('refuses a truncated photo', async () => {
    const whole = await image(800, 800).jpeg().toBuffer();
    expect(await rejection(whole.subarray(0, whole.byteLength / 2), 'gallery')).toBe('unreadable');
  });
});

describe('solidColorPhoto', () => {
  it('makes a real photo of the size and format asked', async () => {
    const png = await solidColorPhoto(640, 480, 'png');
    expect(await sharp(png).metadata()).toMatchObject({ format: 'png', width: 640, height: 480 });
    expect((await sharp(await solidColorPhoto(10, 10)).metadata()).format).toBe('jpeg');
  });
});
