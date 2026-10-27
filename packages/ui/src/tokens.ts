// The design tokens (DESIGN.md §3; direction "A+B" chosen in S39, ADR-0044: plum and marigold on a
// warm off-white): the one source of truth. `theme.css` carries the same values as CSS variables;
// a test keeps the two in step and checks every text/background pair against WCAG 2.2 AA (4.5:1)
// and every control border against 3:1, in both themes.

export type Theme = 'light' | 'dark';

/** Color tokens: name → [light, dark]. */
export const COLORS = {
  bg: ['#F6F1EC', '#1A1418'],
  surface: ['#FFFDFB', '#241C21'],
  'surface-2': ['#EFE7DF', '#2E242B'],
  ink: ['#2A1F26', '#F5EDF1'],
  'ink-2': ['#5E4F58', '#CDBFC7'],
  'ink-3': ['#6F5E68', '#A898A2'],
  line: ['#E4D8CD', '#3A2F36'],
  'line-strong': ['#8E7C86', '#8A7A84'],
  brand: ['#5A2D52', '#E0B3D6'],
  'brand-ink': ['#FFFFFF', '#2A1023'],
  'brand-soft': ['#F0E2EC', '#3B2737'],
  accent: ['#E8A33D', '#F2B85A'],
  'accent-ink': ['#2A1F26', '#2A1F26'],
  'accent-soft': ['#F8E7C8', '#3D3018'],
  ok: ['#2F6B4F', '#7FCBA4'],
  'ok-soft': ['#E3EFE7', '#1F3A2D'],
  warn: ['#8A5A00', '#F0C26B'],
  'warn-soft': ['#F7E9CC', '#3D3018'],
  danger: ['#B3261E', '#FF8A80'],
  'danger-soft': ['#F6DEDB', '#3D1E1C'],
  info: ['#2F5E8A', '#9CC3E8'],
  'info-soft': ['#E1EAF3', '#1C2A38'],
} as const satisfies Record<string, readonly [string, string]>;

export type ColorToken = keyof typeof COLORS;

/**
 * The names screens built before S40 use, mapped onto the new tokens (ADR-0044; DESIGN.md §3).
 * Tailwind classes only (`text-on-brand`, `bg-wait-soft`, …): S41–S43 move the screens onto the
 * kit and S43 deletes these.
 */
export const LEGACY_ALIASES = {
  'on-brand': 'brand-ink',
  'brand-strong': 'brand',
  'on-accent': 'accent-ink',
  wait: 'warn',
  'wait-soft': 'warn-soft',
} as const satisfies Record<string, ColorToken>;

/** The dimmed backdrop behind sheets and dialogs: [light, dark]. */
export const SCRIM = ['rgba(42, 31, 38, 0.45)', 'rgba(0, 0, 0, 0.6)'] as const;

const TEXT_ON_PAGE = ['ink', 'ink-2', 'ink-3', 'brand', 'ok', 'warn', 'danger', 'info'] as const;

/** Text (first) on background (second) pairs the screens use; each must reach 4.5:1. */
export const TEXT_PAIRS: readonly (readonly [ColorToken, ColorToken])[] = [
  ...TEXT_ON_PAGE.flatMap((text) =>
    (['bg', 'surface', 'surface-2'] as const).map((bg) => [text, bg] as const),
  ),
  ['brand-ink', 'brand'],
  ['accent-ink', 'accent'],
  // A selected tab or chip; the owner's calendar blocks, with a booking's time and "outside the
  // usual hours" note.
  ...(['ink', 'ink-2', 'brand', 'warn'] as const).map((text) => [text, 'brand-soft'] as const),
  // The second and third staff members' calendar blocks.
  ...(['ink', 'ink-2'] as const).flatMap((text) =>
    (['accent-soft', 'info-soft'] as const).map((bg) => [text, bg] as const),
  ),
  ['ok', 'ok-soft'],
  ['ink', 'ok-soft'],
  ['warn', 'warn-soft'],
  ['ink', 'warn-soft'],
  ['danger', 'danger-soft'],
  ['ink', 'danger-soft'],
  ['info', 'info-soft'],
];

/**
 * Non-text pairs (WCAG 2.2 AA, 1.4.11): input and control borders, focus rings and the staff
 * bars on their calendar blocks; each must reach 3:1. `line` is a decorative divider and has no
 * minimum.
 */
export const NON_TEXT_PAIRS: readonly (readonly [ColorToken, ColorToken])[] = [
  ...(['line-strong', 'brand'] as const).flatMap((mark) =>
    (['bg', 'surface', 'surface-2'] as const).map((bg) => [mark, bg] as const),
  ),
  ['brand', 'brand-soft'],
  ['info', 'info-soft'],
];

/** The minimum contrast for normal text (WCAG 2.2 AA, 1.4.3). */
export const MIN_TEXT_CONTRAST = 4.5;

/** The minimum contrast for icons, borders and focus rings (WCAG 2.2 AA, 1.4.11). */
export const MIN_NON_TEXT_CONTRAST = 3;

export interface TypeStyle {
  /** `display`: Bricolage Grotesque; `sans`: Figtree. */
  font: 'display' | 'sans';
  /** px */
  size: number;
  lineHeight: number;
  /** em */
  tracking: number;
  weight: number;
}

/** The type scale (DESIGN.md §3): a 1.2 scale from a 16 px body. Amounts add `tabular-nums`. */
export const TYPE_SCALE = {
  'number-xl': { font: 'display', size: 57, lineHeight: 1, tracking: -0.04, weight: 700 },
  display: { font: 'display', size: 33, lineHeight: 1.1, tracking: -0.02, weight: 700 },
  title: { font: 'display', size: 28, lineHeight: 1.15, tracking: -0.02, weight: 700 },
  heading: { font: 'display', size: 23, lineHeight: 1.2, tracking: -0.01, weight: 700 },
  subheading: { font: 'sans', size: 19, lineHeight: 1.3, tracking: 0, weight: 700 },
  body: { font: 'sans', size: 16, lineHeight: 1.45, tracking: 0, weight: 400 },
  label: { font: 'sans', size: 14, lineHeight: 1.4, tracking: 0, weight: 600 },
  caption: { font: 'sans', size: 13, lineHeight: 1.35, tracking: 0, weight: 500 },
} as const satisfies Record<string, TypeStyle>;

export type TypeToken = keyof typeof TYPE_SCALE;

/** Spacing steps in px; Tailwind's 4 px unit gives each (`p-1` … `p-16`). */
export const SPACE = [4, 8, 12, 16, 20, 24, 32, 40, 48, 64] as const;

/** Corner radii in px: inner tiles, inputs and chips, cards, the briefing block and sheet tops, pills. */
export const RADII = { sm: 12, md: 16, lg: 24, xl: 32, pill: 999 } as const;

/** Shadows: [light, dark]. Rows and wells are flat; only decision cards are raised. */
export const ELEVATION = {
  raised: [
    '0 1px 2px rgba(42, 31, 38, 0.06), 0 10px 28px rgba(42, 31, 38, 0.07)',
    '0 1px 2px rgba(0, 0, 0, 0.5)',
  ],
  floating: ['0 -8px 32px rgba(42, 31, 38, 0.16)', '0 -8px 32px rgba(0, 0, 0, 0.6)'],
} as const;

/** Durations in ms (all 0 under `prefers-reduced-motion`) and the one easing. */
export const MOTION = {
  fast: 120,
  base: 180,
  slow: 240,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

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
