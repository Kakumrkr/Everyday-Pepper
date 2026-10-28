// @ts-check
// The design rules ESLint enforces in apps/web and packages/ui (DESIGN.md §5, ADR-0044):
// D1 colors only from tokens, D7 motion only from the motion tokens. Each entry is a
// `no-restricted-syntax` restriction; eslint.config.js adds them next to the raw-HTML ones (one
// rule, so the two lists can't override each other), and eslint-design.test.js proves each one.

const COLOR_FUNCTION = String.raw`\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(`;
const HEX = String.raw`(^|[^&\w])#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w-])`;
const TAILWIND_PALETTE = String.raw`\b(bg|text|border|border-[trblxy]|ring|ring-offset|outline|fill|stroke|from|via|to|divide|decoration|accent|caret|shadow|placeholder)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}\b`;
const TAILWIND_BLACK_WHITE = String.raw`\b(bg|text|border|ring|outline|fill|stroke|divide)-(black|white)\b`;
const TAILWIND_ARBITRARY_COLOR = String.raw`\b(bg|text|border|ring|outline|fill|stroke|from|via|to|divide|decoration|shadow)-\[(#|color:|(rgba?|hsla?|oklch)\()`;
const TAILWIND_DURATION = String.raw`\b(duration|delay)-([0-9]+|\[)`;

/** @param {string} pattern */
const inStrings = (pattern) => [
  `Literal[value=/${pattern}/]`,
  `TemplateElement[value.raw=/${pattern}/]`,
];

const COLOR_MESSAGE =
  'Colors come from the design tokens only (DESIGN.md D1): use a token class such as `text-ink-2` or `bg-brand`.';
const MOTION_MESSAGE =
  'Durations come from the motion tokens only (DESIGN.md D7): use `motion-fast`, `motion-base` or `motion-slow`.';

/** The `no-restricted-syntax` entries for the design rules. */
export const designRestrictions = [
  ...[HEX, COLOR_FUNCTION].flatMap(inStrings).map((selector) => ({
    selector,
    message: COLOR_MESSAGE,
  })),
  ...[TAILWIND_PALETTE, TAILWIND_BLACK_WHITE, TAILWIND_ARBITRARY_COLOR]
    .flatMap(inStrings)
    .map((selector) => ({ selector, message: COLOR_MESSAGE })),
  ...inStrings(TAILWIND_DURATION).map((selector) => ({ selector, message: MOTION_MESSAGE })),
  {
    // An inline style that sets its own timing: `style={{ transition: '…' }}`.
    selector:
      'Property[key.name=/^(transition|transitionDuration|transitionDelay|animation|animationDuration|animationDelay)$/]',
    message: MOTION_MESSAGE,
  },
];

/**
 * Files that may hold raw colors, each for a reason: the tokens themselves, the arithmetic that
 * derives a business's booking-page colors (PCR-001), the colour stored for a new staff member
 * (stored data the api requires; screens show tones instead, S42.2), and tests, which compare
 * values.
 */
export const designExemptFiles = [
  'packages/ui/src/tokens.ts',
  'packages/ui/src/brand.ts',
  'apps/web/lib/setup.ts',
  'apps/web/**/*.test.{ts,tsx}',
  'packages/ui/**/*.test.{ts,tsx}',
];
