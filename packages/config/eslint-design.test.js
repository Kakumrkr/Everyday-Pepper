// The design lint (DESIGN.md D1, D7; S40): every restriction catches what it is for and lets
// token classes through, and the repository's ESLint config applies it where DESIGN.md says.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { designExemptFiles, designRestrictions } from './eslint-design.js';

const linter = new Linter({ configType: 'flat' });
const config = [
  {
    files: ['**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: { 'no-restricted-syntax': ['error', ...designRestrictions] },
  },
];

/** The messages ESLint reports for `code` in a component file. */
function lint(code) {
  return linter.verify(code, config, 'component.tsx').map((m) => m.message);
}

describe('design restrictions', () => {
  const refused = {
    'a hex color': `const c = '#5A2D52';`,
    'a short hex color in a style': `<div style={{ color: '#fff' }} />`,
    'an 8-digit hex color': `const c = '#5a2d52cc';`,
    'a hex color in a template string': 'const s = `border: 1px solid #e4d8cd`;',
    'rgb()': `const c = 'rgb(0, 0, 0)';`,
    'rgba() in a style': `<div style={{ background: 'rgba(42, 31, 38, 0.45)' }} />`,
    'hsl()': `const c = 'hsl(300 30% 26%)';`,
    'oklch()': `const c = 'oklch(0.4 0.1 330)';`,
    'a Tailwind palette class': `<p className="text-gray-500" />`,
    'a Tailwind palette class with a variant': `<p className="mt-2 hover:bg-rose-100" />`,
    'a Tailwind side border palette class': `<p className="border-l-red-500" />`,
    'black or white': `<p className="bg-white text-black" />`,
    'an arbitrary color': `<p className="bg-[#5A2D52]" />`,
    'an arbitrary rgb color': `<p className="text-[rgb(0,0,0)]" />`,
    'a Tailwind duration': `<p className="transition duration-300" />`,
    'an arbitrary delay': `<p className="delay-[50ms]" />`,
    'an inline transition': `<div style={{ transition: 'opacity 200ms' }} />`,
    'an inline animation duration': `<div style={{ animationDuration: '1s' }} />`,
  };

  for (const [name, code] of Object.entries(refused)) {
    it(`refuses ${name}`, () => {
      assert.ok(lint(code).length > 0, code);
    });
  }

  const allowed = {
    'token classes': `<p className="bg-brand text-brand-ink border-line-strong ring-brand" />`,
    'soft and status tokens': `<p className="bg-accent-soft text-warn divide-line shadow-raised" />`,
    'motion tokens': `<p className="transition-colors motion-fast ease-standard" />`,
    'an anchor link': `<a href="#main">Skip</a>`,
    'an id that is not a color': `const id = '#add-client';`,
    'an HTML entity': `const s = 'Tom &#039;s';`,
    'a stored color from the data': `<span style={{ background: member.color }} />`,
    'words that only look like functions': `const s = 'Pick a color (any)';`,
    'a background image': `<div style={{ backgroundImage: 'none' }} />`,
  };

  for (const [name, code] of Object.entries(allowed)) {
    it(`allows ${name}`, () => {
      assert.deepEqual(lint(code), [], code);
    });
  }
});

describe('the repository config', () => {
  const eslint = new ESLint({ cwd: fileURLToPath(new URL('../..', import.meta.url)) });

  /** The `no-restricted-syntax` selectors in force for `file`. */
  async function selectorsFor(file) {
    const { rules } = await eslint.calculateConfigForFile(file);
    return (rules?.['no-restricted-syntax'] ?? []).slice(1).map((entry) => entry.selector);
  }

  for (const file of [
    'apps/web/app/(app)/page.tsx',
    'apps/web/lib/calendar.ts',
    'packages/ui/src/button.tsx',
  ]) {
    it(`applies the design rules and the raw-HTML rules to ${file}`, async () => {
      const selectors = await selectorsFor(file);
      for (const { selector } of designRestrictions) assert.ok(selectors.includes(selector));
      assert.ok(selectors.some((s) => s.includes('dangerouslySetInnerHTML')));
    });
  }

  for (const file of [
    'packages/ui/src/tokens.ts',
    'apps/web/lib/setup.ts',
    'apps/web/x.test.tsx',
  ]) {
    it(`exempts ${file} from the design rules only`, async () => {
      const selectors = await selectorsFor(file);
      assert.ok(!selectors.includes(designRestrictions[0]?.selector));
      assert.ok(selectors.some((s) => s.includes('dangerouslySetInnerHTML')));
    });
  }

  it('leaves test files outside the web app and the kit alone', async () => {
    assert.deepEqual(await selectorsFor('apps/api/src/x.test.ts'), []);
  });

  it('lists only a few exempt files, each named in eslint-design.js', () => {
    assert.ok(designExemptFiles.length <= 5);
  });
});

describe('stylesheets', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));

  /** Every .css file under `dir`, but not dependencies or build output. */
  function stylesheets(dir) {
    const skipped = new Set(['node_modules', '.next', 'dist', 'coverage']);
    return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return skipped.has(entry.name) ? [] : stylesheets(path);
      return entry.name.endsWith('.css') ? [join(root, path)] : [];
    });
  }

  it('hold raw colors and durations only in the theme (D1, D7)', () => {
    const files = [...stylesheets('apps/web'), ...stylesheets('packages/ui')].filter(
      (path) => !path.endsWith('packages/ui/src/theme.css'),
    );
    assert.ok(files.some((path) => path.endsWith('globals.css')));
    for (const path of files) {
      const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch)\(/i, path);
      assert.doesNotMatch(css, /\b\d+(\.\d+)?m?s\b/, path);
    }
  });
});
