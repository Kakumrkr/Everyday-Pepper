import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BRAND_TEXT_PAIRS,
  brandTokens,
  brandStyle,
  DEFAULT_BRAND_COLOR,
  pageColor,
} from './brand.js';
import { contrastRatio, MIN_TEXT_CONTRAST, type Theme } from './tokens.js';

const themes: Theme[] = ['light', 'dark'];
const hexColor = fc
  .tuple(
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
  )
  .map((channels) => `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`);

function failingPairs(hex: string | null, theme: Theme): string[] {
  const tokens = brandTokens(hex)[theme];
  return BRAND_TEXT_PAIRS.filter(
    ([text, bg]) =>
      contrastRatio(pageColor(text, tokens, theme), pageColor(bg, tokens, theme)) <
      MIN_TEXT_CONTRAST,
  ).map(([text, bg]) => `${text} on ${bg}`);
}

describe('brandTokens (PCR-001)', () => {
  it('passes WCAG AA for every text pair, for any color, in both themes (property)', () => {
    fc.assert(
      fc.property(hexColor, (hex) => {
        for (const theme of themes) expect(failingPairs(hex, theme), `${hex} ${theme}`).toEqual([]);
      }),
      { numRuns: 2000 },
    );
  });

  it.each(['#ffffff', '#000000', '#ffff00', '#00ff00', '#7a3e6c', '#808080'])(
    'adjusts the hard case %s',
    (hex) => {
      for (const theme of themes) expect(failingPairs(hex, theme)).toEqual([]);
    },
  );

  it('keeps a color that already passes, and the sample plum stays plum', () => {
    expect(brandTokens('#7a3b8f').light.biz).toBe('#7a3b8f');
    expect(brandTokens('#7A3B8F').light['biz-on']).toBe('#ffffff');
  });

  it('uses the slate default without a color, not Pepper’s own green', () => {
    expect(brandTokens(null)).toEqual(brandTokens(DEFAULT_BRAND_COLOR));
    for (const theme of themes) expect(failingPairs(null, theme)).toEqual([]);
  });

  it('refuses a malformed color', () => {
    expect(() => brandTokens('plum')).toThrow(RangeError);
  });

  it('carries both themes as CSS variables', () => {
    const tokens = brandTokens('#7a3b8f');
    expect(brandStyle(tokens)).toEqual({
      '--biz-light': tokens.light.biz,
      '--biz-strong-light': tokens.light['biz-strong'],
      '--biz-soft-light': tokens.light['biz-soft'],
      '--biz-on-light': tokens.light['biz-on'],
      '--biz-dark': tokens.dark.biz,
      '--biz-strong-dark': tokens.dark['biz-strong'],
      '--biz-soft-dark': tokens.dark['biz-soft'],
      '--biz-on-dark': tokens.dark['biz-on'],
    });
  });
});
