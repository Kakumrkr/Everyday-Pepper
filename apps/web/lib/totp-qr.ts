import { encode } from 'uqr';

/** Dark modules of the QR code for `text`, as `[x, y]` pairs, plus the grid size. */
export function qrModules(text: string): { size: number; dark: [number, number][] } {
  const { data, size } = encode(text, { ecc: 'M', border: 2 });
  const dark: [number, number][] = [];
  data.forEach((row, y) => {
    row.forEach((on, x) => {
      if (on) dark.push([x, y]);
    });
  });
  return { size, dark };
}

/** The base32 secret in an `otpauth://` URI, grouped in fours for typing it by hand. */
export function manualSecret(totpUri: string): string | null {
  const secret = URL.canParse(totpUri) ? new URL(totpUri).searchParams.get('secret') : null;
  return secret?.match(/.{1,4}/g)?.join(' ') ?? null;
}
