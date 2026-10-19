// The approved design tokens (docs/product/ux-principles.md; pepper green + chili accent since
// PCR-002, 2026-10-18): the one source of truth. `theme.css` carries the same values as CSS
// variables; a test keeps the two in step and checks every text/background pair against
// WCAG 2.2 AA in both themes.

export type Theme = 'light' | 'dark';

/** Color tokens: name → [light, dark]. */
export const COLORS = {
  bg: ['#F7FAF5', '#0F1510'],
  surface: ['#FFFFFF', '#172019'],
  'surface-2': ['#EDF3EA', '#202A22'],
  line: ['#DCE6D8', '#2F3B31'],
  ink: ['#1B2A1E', '#EAF3EA'],
  'ink-2': ['#536257', '#A7B7AA'],
  brand: ['#2A7230', '#86D28E'],
  'brand-strong': ['#23652A', '#97DB9E'],
  'brand-soft': ['#E2F0E0', '#1B3320'],
  'on-brand': ['#FFFFFF', '#0A1F0D'],
  accent: ['#C2361B', '#FF8C70'],
  'accent-soft': ['#FDE6DF', '#3D1E16'],
  'on-accent': ['#FFFFFF', '#2A0B04'],
  ok: ['#0B6B63', '#6BD5C6'],
  'ok-soft': ['#DDF1EE', '#13322E'],
  wait: ['#8F4C00', '#FFC274'],
  'wait-soft': ['#FFEFD6', '#3A2A12'],
  info: ['#1D65A8', '#8CC2F5'],
  'info-soft': ['#E2EEFA', '#172B3E'],
  danger: ['#9F1D2B', '#FFB4AB'],
  s1: ['#E2F0DC', '#1E3519'],
  's1-ink': ['#2D5C25', '#B5E3A8'],
  s2: ['#FDE4DB', '#40211A'],
  's2-ink': ['#8A2D14', '#FFC4B3'],
  s3: ['#FFEFC7', '#3D3012'],
  's3-ink': ['#7A4F00', '#FFDE8A'],
} as const satisfies Record<string, readonly [string, string]>;

export type ColorToken = keyof typeof COLORS;

/** Text (first) on background (second) pairs the screens use; each must reach 4.5:1. */
export const TEXT_PAIRS: readonly (readonly [ColorToken, ColorToken])[] = [
  ...(['ink', 'ink-2', 'brand', 'accent', 'danger'] as const).flatMap((text) =>
    (['bg', 'surface', 'surface-2'] as const).map((bg) => [text, bg] as const),
  ),
  ['ink', 'brand-soft'],
  ['ink-2', 'brand-soft'],
  ['brand', 'brand-soft'],
  // A calendar booking's time and "outside the usual hours" note.
  ['wait', 'brand-soft'],
  ['on-brand', 'brand'],
  ['on-brand', 'brand-strong'],
  ['accent', 'accent-soft'],
  ['on-accent', 'accent'],
  ['ok', 'ok-soft'],
  ['wait', 'wait-soft'],
  ['info', 'info-soft'],
  ['s1-ink', 's1'],
  ['s2-ink', 's2'],
  ['s3-ink', 's3'],
];

/** The minimum contrast for normal text (WCAG 2.2 AA, 1.4.3). */
export const MIN_TEXT_CONTRAST = 4.5;

/** Corner radii in px (sm / md / lg cards); buttons and chips are pills. */
export const RADII = { sm: 10, md: 16, lg: 24 } as const;

/** The smallest tap target in px (one-thumb use, WCAG 2.5.8 with margin). */
export const MIN_TAP_TARGET = 44;

/** The width in px from which the app shows the sidebar instead of bottom tabs. */
export const DESKTOP_MIN_WIDTH = 960;

/** The color of `token` in `theme`. */
export function color(token: ColorToken, theme: Theme): string {
  return COLORS[token][theme === 'light' ? 0 : 1];
}

function channels(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (match === null) throw new RangeError(`Not a #rrggbb color: ${hex}`);
  return [match[1], match[2], match[3]].map((part) => Number.parseInt(part ?? '', 16)) as [
    number,
    number,
    number,
  ];
}

/** Relative luminance of a `#rrggbb` color (WCAG 2.2 definition). */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio of two `#rrggbb` colors, 1–21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}
