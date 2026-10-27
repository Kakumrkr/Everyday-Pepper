import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COLORS,
  DESKTOP_MIN_WIDTH,
  ELEVATION,
  LEGACY_ALIASES,
  MIN_NON_TEXT_CONTRAST,
  MIN_TEXT_CONTRAST,
  MOTION,
  NON_TEXT_PAIRS,
  RADII,
  SCRIM,
  SPACE,
  TEXT_PAIRS,
  TYPE_SCALE,
  color,
  contrastRatio,
  type ColorToken,
  type Theme,
} from './tokens.js';

const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');

/** The first `:root { … }` block of `theme` (light: the default; dark: the media query). */
function themeBlock(theme: Theme): string {
  const start = css.indexOf(':root {', theme === 'light' ? 0 : css.indexOf('prefers-color-scheme'));
  return css.slice(start, css.indexOf('}', start));
}

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

  it('maps each name screens built before S40 use onto its new token', () => {
    for (const [alias, token] of Object.entries(LEGACY_ALIASES)) {
      expect(css).toContain(`--color-${alias}: var(--${token});`);
      expect(alias in COLORS, alias).toBe(false);
    }
  });

  it('carries the type scale', () => {
    for (const [name, style] of Object.entries(TYPE_SCALE)) {
      expect(css).toContain(`--text-${name}: ${String(style.size)}px;`);
      expect(css).toContain(`--text-${name}--line-height: ${String(style.lineHeight)};`);
      expect(css).toContain(`--text-${name}--letter-spacing: ${String(style.tracking)}em;`);
      expect(css).toContain(`--text-${name}--font-weight: ${String(style.weight)};`);
      expect(css).toMatch(
        new RegExp(`@utility type-${name} \\{\\s*font-family: var\\(--font-${style.font}\\);`),
      );
    }
  });

  it('carries the radii, the 4 px spacing unit and the desktop breakpoint', () => {
    for (const [name, px] of Object.entries(RADII)) {
      expect(css).toContain(`--radius-${name}: ${String(px)}px;`);
    }
    expect(css).toContain('--spacing: 0.25rem;');
    for (const step of SPACE) expect(step % 4).toBe(0);
    expect(css).toContain(`--breakpoint-desk: ${String(DESKTOP_MIN_WIDTH / 16)}rem;`);
  });

  it.each(themes)('carries the %s scrim and shadows', (theme) => {
    const block = themeBlock(theme);
    const i = theme === 'light' ? 0 : 1;
    expect(block).toContain(`--scrim: ${SCRIM[i]};`);
    expect(block).toContain(`--elevation-raised: ${ELEVATION.raised[i]};`);
    expect(block).toContain(`--elevation-floating: ${ELEVATION.floating[i]};`);
  });

  it('carries the motion tokens, and turns them off under reduced motion', () => {
    for (const name of ['fast', 'base', 'slow'] as const) {
      expect(themeBlock('light')).toContain(`--motion-${name}: ${String(MOTION[name])}ms;`);
      expect(css).toMatch(new RegExp(`@utility motion-${name} \\{[^}]*var\\(--motion-${name}\\)`));
    }
    const reduced = css.slice(css.indexOf('prefers-reduced-motion: reduce'));
    expect(reduced.slice(0, reduced.indexOf('}'))).toMatch(
      /--motion-fast: 0ms;\s*--motion-base: 0ms;\s*--motion-slow: 0ms;/,
    );
    expect(css).toContain(`--ease-standard: ${MOTION.easing};`);
    // Sheets and overlays animate through the same tokens.
    expect(css).toContain('--animate-sheet-in: sheet-in var(--motion-slow) var(--ease-standard);');
    expect(css).toContain('--animate-fade-in: fade-in var(--motion-base) var(--ease-standard);');
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

describe('contrast of icons, borders and focus rings (WCAG 2.2 AA)', () => {
  it.each(
    themes.flatMap((theme) => NON_TEXT_PAIRS.map(([mark, bg]) => [theme, mark, bg] as const)),
  )('%s: %s on %s reaches 3:1', (theme, mark, bg) => {
    expect(contrastRatio(color(mark, theme), color(bg, theme))).toBeGreaterThanOrEqual(
      MIN_NON_TEXT_CONTRAST,
    );
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for a color on itself, in either order', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#2A7230', '#2a7230')).toBe(1);
  });

  it('refuses anything but #rrggbb', () => {
    expect(() => contrastRatio('#fff', '#000000')).toThrow(RangeError);
    expect(() => contrastRatio('red', '#000000')).toThrow(RangeError);
  });
});
