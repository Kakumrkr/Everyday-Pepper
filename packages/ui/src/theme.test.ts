import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COLORS,
  DESKTOP_MIN_WIDTH,
  MIN_TEXT_CONTRAST,
  RADII,
  TEXT_PAIRS,
  color,
  contrastRatio,
  type ColorToken,
  type Theme,
} from './tokens.js';

const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');

/** The `--name: #hex` declarations of the first `:root { … }` block after `from`. */
function rootVariables(from: number): Map<string, string> {
  const start = css.indexOf(':root {', from);
  const block = css.slice(start, css.indexOf('}', start));
  return new Map(
    [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [
      m[1] ?? '',
      (m[2] ?? '').toUpperCase(),
    ]),
  );
}

const themes: Theme[] = ['light', 'dark'];
const tokens = Object.keys(COLORS) as ColorToken[];

describe('theme.css', () => {
  it.each(themes)('carries exactly the %s token values', (theme) => {
    const variables = rootVariables(theme === 'light' ? 0 : css.indexOf('prefers-color-scheme'));
    expect(Object.fromEntries(variables)).toEqual(
      Object.fromEntries(tokens.map((token) => [token, color(token, theme)])),
    );
  });

  it('maps every token to a Tailwind color', () => {
    for (const token of tokens) {
      expect(css).toContain(`--color-${token}: var(--${token});`);
    }
  });

  it('carries the radii and the desktop breakpoint', () => {
    for (const [name, px] of Object.entries(RADII)) {
      expect(css).toContain(`--radius-${name}: ${String(px)}px;`);
    }
    expect(css).toContain(`--breakpoint-desk: ${String(DESKTOP_MIN_WIDTH / 16)}rem;`);
  });
});

describe('contrast (WCAG 2.2 AA)', () => {
  it.each(themes.flatMap((theme) => TEXT_PAIRS.map(([text, bg]) => [theme, text, bg] as const)))(
    '%s: %s on %s reaches 4.5:1',
    (theme, text, bg) => {
      expect(contrastRatio(color(text, theme), color(bg, theme))).toBeGreaterThanOrEqual(
        MIN_TEXT_CONTRAST,
      );
    },
  );
});

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for a color on itself, in either order', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#BE2759', '#be2759')).toBe(1);
  });

  it('refuses anything but #rrggbb', () => {
    expect(() => contrastRatio('#fff', '#000000')).toThrow(RangeError);
    expect(() => contrastRatio('red', '#000000')).toThrow(RangeError);
  });
});
