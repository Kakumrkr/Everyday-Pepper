import sharp, { type Metadata } from 'sharp';

/** What a business photo is for (ADR-0048, AC-W8-10/11). */
export type PhotoKind = 'logo' | 'cover' | 'gallery';

/** The largest upload accepted, in bytes (10 MB). */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
/** The most pixels a photo may have (40 megapixels): stops decompression bombs. */
export const MAX_PHOTO_PIXELS = 40_000_000;
/** The longest side may be at most this many times the shortest. */
export const MAX_ASPECT_RATIO = 4;

/** The short side a photo needs, per kind, and the widths it is kept at. */
export const PHOTO_RULES: Readonly<
  Record<PhotoKind, { minShortSide: number; widths: readonly number[] }>
> = {
  logo: { minShortSide: 128, widths: [128, 256] },
  cover: { minShortSide: 600, widths: [640, 1280, 1920] },
  gallery: { minShortSide: 600, widths: [320, 640, 1280] },
};

/** Any image Pepper keeps: a business photo, or a screenshot on a support request (ADR-0062). */
export type ImageKind = PhotoKind | 'screenshot';

/**
 * A support screenshot's rules (ADR-0062 Part 3, AC-X-28): any size from a small dialog up,
 * long phone screenshots (1:8), kept sharp enough to read text (2560 px, quality 90) with a
 * 480 px thumbnail for the thread.
 */
export const SCREENSHOT_RULES = {
  minShortSide: 16,
  widths: [480, 2560],
  maxAspectRatio: 8,
  quality: 90,
} as const;

interface ImageRules {
  minShortSide: number;
  widths: readonly number[];
  maxAspectRatio: number;
  quality: number;
  /** The word the refusals use. */
  noun: 'photo' | 'screenshot';
}

function rulesFor(kind: ImageKind): ImageRules {
  if (kind === 'screenshot') return { ...SCREENSHOT_RULES, noun: 'screenshot' };
  return { ...PHOTO_RULES[kind], maxAspectRatio: MAX_ASPECT_RATIO, quality: 82, noun: 'photo' };
}

/** Why an upload was refused; the api turns each into words the owner can act on. */
export type ImageRejection =
  | 'too_large'
  | 'unsupported_type'
  | 'heic'
  | 'unreadable'
  | 'too_many_pixels'
  | 'too_small'
  | 'bad_shape';

export class ImageRejectedError extends Error {
  constructor(
    readonly reason: ImageRejection,
    message: string,
  ) {
    super(message);
    this.name = 'ImageRejectedError';
  }
}

export interface ImageVariant {
  width: number;
  height: number;
  /** WebP, without metadata. */
  data: Buffer;
}

export interface ProcessedImage {
  /** The upright original's size. */
  width: number;
  height: number;
  /** Narrowest first; never wider than the original. */
  variants: ImageVariant[];
}

const ACCEPTED = new Set(['jpeg', 'png', 'webp']);
const sharpOptions = { limitInputPixels: MAX_PHOTO_PIXELS, failOn: 'error' } as const;
// Reading the header decodes no pixels, so it needs no pixel limit: the count is checked below.
const headerOptions = { limitInputPixels: false, failOn: 'error' } as const;

/**
 * The widths to keep for an image `width` px wide: each target narrower than it, and the
 * widest target capped at the image's own width, so there is always at least one and none is
 * enlarged.
 */
export function variantWidths(width: number, targets: readonly number[]): number[] {
  const widest = Math.min(width, Math.max(...targets));
  return [...new Set([...targets.filter((target) => target < widest), widest])].sort(
    (a, b) => a - b,
  );
}

/**
 * Checks an uploaded image by what its bytes are (never its name or label) and remakes it
 * (ADR-0048, AC-W8-10; screenshots ADR-0062, AC-X-28): JPEG, PNG or WebP, at most 10 MB and
 * 40 megapixels, at least the kind's short side and at most its shape; turned upright and
 * re-encoded as WebP without metadata (no location or device) at the kind's widths. Throws
 * `ImageRejectedError`, whose message names the kind ("photo" or "screenshot").
 */
export async function processImage(input: Uint8Array, kind: ImageKind): Promise<ProcessedImage> {
  const rules = rulesFor(kind);
  const noun = rules.noun;
  const unreadable = `That file is not a ${noun} we can read. Use a JPEG, PNG or WebP ${noun}.`;
  if (input.byteLength > MAX_PHOTO_BYTES) {
    throw new ImageRejectedError('too_large', `That ${noun} is over 10 MB.`);
  }
  let metadata: Metadata;
  try {
    // Reads the header only: the pixel count is checked before anything is decoded.
    metadata = await sharp(input, headerOptions).metadata();
  } catch {
    throw new ImageRejectedError('unreadable', unreadable);
  }
  if (metadata.format === 'heif') {
    throw new ImageRejectedError(
      'heic',
      `HEIC ${noun}s are not supported yet. Save it as a JPEG${noun === 'screenshot' ? ' or PNG' : ''}.`,
    );
  }
  if (!ACCEPTED.has(metadata.format)) {
    throw new ImageRejectedError('unsupported_type', `Use a JPEG, PNG or WebP ${noun}.`);
  }
  const rawWidth = metadata.width;
  const rawHeight = metadata.height;
  if (rawWidth * rawHeight > MAX_PHOTO_PIXELS) {
    throw new ImageRejectedError(
      'too_many_pixels',
      `That ${noun} has too many pixels (over 40 MP).`,
    );
  }
  // EXIF orientations 5–8 turn the picture a quarter: its upright width is the stored height.
  const quarterTurn = (metadata.orientation ?? 1) >= 5;
  const width = quarterTurn ? rawHeight : rawWidth;
  const height = quarterTurn ? rawWidth : rawHeight;
  if (Math.min(width, height) < rules.minShortSide) {
    throw new ImageRejectedError(
      'too_small',
      `That ${noun} is too small. Use one at least ${String(rules.minShortSide)} px on its short side.`,
    );
  }
  if (Math.max(width, height) > rules.maxAspectRatio * Math.min(width, height)) {
    throw new ImageRejectedError(
      'bad_shape',
      noun === 'photo'
        ? 'That photo is too long and thin. Crop it closer to a square.'
        : 'That screenshot is too long and thin. Crop it to the part that shows the problem.',
    );
  }
  try {
    const variants = await Promise.all(
      variantWidths(width, rules.widths).map(async (target) => {
        // `rotate()` with no angle turns it upright; sharp writes no metadata unless asked.
        const { data, info } = await sharp(input, sharpOptions)
          .rotate()
          .resize({ width: target, withoutEnlargement: true })
          .webp({ quality: rules.quality })
          .toBuffer({ resolveWithObject: true });
        return { width: info.width, height: info.height, data };
      }),
    );
    return { width, height, variants };
  } catch {
    throw new ImageRejectedError('unreadable', unreadable);
  }
}

/**
 * A photo of one color, `width`×`height`, as a JPEG, PNG or WebP file: for tests and the e2e
 * journeys, which need real images without fixtures on disk.
 */
export function solidColorPhoto(
  width: number,
  height: number,
  format: 'jpeg' | 'png' | 'webp' = 'jpeg',
  color = { r: 176, g: 108, b: 72 },
): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .toFormat(format)
    .toBuffer();
}
