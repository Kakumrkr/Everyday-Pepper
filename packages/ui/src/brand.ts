import { color, contrastRatio, MIN_TEXT_CONTRAST, type Theme } from './tokens.js';

// The booking page's colors from the business's own brand color (PCR-001, ADR-0022). Any
// color the owner picks is adjusted, never refused: the main color is darkened (light theme) or
// lightened (dark theme) until text in it, and text on it, passes WCAG AA on every background
// the page uses. The page maps these onto the `brand` tokens, so its screens need no other
// change.

/** The page's colors when the business has picked none: a quiet slate, not Pepper's green. */
export const DEFAULT_BRAND_COLOR = '#455a64';

export interface BrandTokens {
  /** Text, links and buttons in the brand color. */
  biz: string;
  /** Pressed buttons. */
  'biz-strong': string;
  /** Tinted backgrounds (selected items, avatars). */
  'biz-soft': string;
  /** Text on `biz` and `biz-strong`. */
  'biz-on': string;
}

/** Text (first) on background (second) pairs of the booking page; each must reach 4.5:1. */
export const BRAND_TEXT_PAIRS: readonly (readonly [string, string])[] = [
  ['biz', 'bg'],
  ['biz', 'surface'],
  ['biz', 'surface-2'],
  ['biz', 'biz-soft'],
  ['biz-on', 'biz'],
  ['biz-on', 'biz-strong'],
  ['ink', 'biz-soft'],
  ['ink-2', 'biz-soft'],
];

const WHITE = '#ffffff';
const BLACK = '#000000';
const STEP = 0.02;

/** The brand tokens of `hex` (`null`: the default) in both themes. */
export function brandTokens(hex: string | null): Record<Theme, BrandTokens> {
  const base = (hex ?? DEFAULT_BRAND_COLOR).toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(base)) throw new RangeError(`Not a #rrggbb color: ${base}`);
  return { light: tokensFor(base, 'light'), dark: tokensFor(base, 'dark') };
}

/**
 * CSS variables carrying both themes' brand tokens, for the booking page's `style` attribute;
 * the page's stylesheet maps them onto `--brand`, `--brand-soft` and `--brand-ink` by the
 * system's light or dark setting (`biz-strong` stays for its contrast check only).
 */
export function brandStyle(tokens: Record<Theme, BrandTokens>): Record<string, string> {
  return Object.fromEntries(
    (['light', 'dark'] as const).flatMap((theme) =>
      Object.entries(tokens[theme]).map(([name, value]) => [`--${name}-${theme}`, value]),
    ),
  );
}

/** The color of a page token: a brand token, or one of the design system's. */
export function pageColor(name: string, tokens: BrandTokens, theme: Theme): string {
  return name in tokens ? tokens[name as keyof BrandTokens] : color(name as never, theme);
}

function tokensFor(base: string, theme: Theme): BrandTokens {
  const light = theme === 'light';
  const backgrounds = (['bg', 'surface', 'surface-2'] as const).map((t) => color(t, theme));
  // Tint first: the soft background must carry body text (ink, ink-2).
  const soft = adjust(
    mix(base, light ? WHITE : color('bg', theme), light ? 0.88 : 0.78),
    light ? WHITE : BLACK,
    (c) => passes(color('ink', theme), c) && passes(color('ink-2', theme), c),
  );
  // Then the main color: readable on every background and on its tint.
  const biz = adjust(base, light ? BLACK : WHITE, (c) =>
    [...backgrounds, soft].every((bg) => passes(c, bg)),
  );
  const strong = mix(biz, light ? BLACK : WHITE, 0.15);
  // Text on the brand color: white (light theme) or a deep shade of it (dark theme).
  const on = adjust(
    light ? WHITE : mix(base, BLACK, 0.85),
    light ? WHITE : BLACK,
    (c) => passes(c, biz) && passes(c, strong),
  );
  return { biz, 'biz-strong': strong, 'biz-soft': soft, 'biz-on': on };
}

function passes(text: string, background: string): boolean {
  return contrastRatio(text, background) >= MIN_TEXT_CONTRAST;
}

/**
 * `from`, mixed toward `toward` in small steps until `ok` holds. Ends at `toward` itself, which
 * the callers' checks always accept (black or white text on the design system's backgrounds).
 */
function adjust(from: string, toward: string, ok: (candidate: string) => boolean): string {
  for (let amount = 0; amount < 1; amount += STEP) {
    const candidate = mix(from, toward, amount);
    if (ok(candidate)) return candidate;
  }
  return toward;
}

/** `a` mixed with `b` by `amount` (0: a, 1: b), in sRGB. */
function mix(a: string, b: string, amount: number): string {
  const [ra, ga, ba] = rgb(a);
  const [rb, gb, bb] = rgb(b);
  const channel = (x: number, y: number) =>
    Math.round(x + (y - x) * amount)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(ra, rb)}${channel(ga, gb)}${channel(ba, bb)}`;
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
