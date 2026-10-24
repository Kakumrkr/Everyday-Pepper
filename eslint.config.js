// @ts-check
import { defineConfig } from 'eslint/config';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import eslint from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Layer boundaries (CLAUDE.md "Architecture rules", docs/plan/dependency-map.md).
 * Each package may import only the @pepper packages listed for it; everything else is an error.
 * Add a row when a package is created.
 */
const allowedInternalImports = {
  'packages/config': [],
  'packages/contracts': [],
  'packages/db': ['contracts', 'testing'],
  'packages/core': ['contracts', 'db', 'testing'],
  'packages/modules/*': ['contracts', 'db', 'core', 'testing'],
  'packages/templates': ['contracts'],
  // ADR-0029: the AI's tools are thin adapters over the domain services (core and the modules)
  // and run in their member transactions (db's `withMember`, types); never L3 templates.
  'packages/ai': ['contracts', 'core', 'db', 'appointments', 'testing'],
  'packages/integrations': ['contracts', 'core'],
  'packages/ui': ['contracts'],
  'packages/runtime': ['contracts', 'core', 'db', 'testing'],
  // Test-only helpers; a devDependency wherever used, so a production import fails the image.
  'packages/testing': [],
  // Apps also get each modules/* package as it is created.
  'apps/api': ['contracts', 'core', 'db', 'ai', 'runtime', 'testing', 'appointments', 'templates'],
  // S31 (ADR-0037): the episode job summarises and embeds through the AI package's ports.
  // S35 (ADR-0039): the insights job passes the templates' thresholds to the appointments pass.
  'apps/worker': [
    'contracts',
    'core',
    'db',
    'ai',
    'integrations',
    'runtime',
    'testing',
    'appointments',
    'templates',
  ],
  'apps/web': ['contracts', 'ui'],
  e2e: ['contracts', 'testing'],
};

const boundaryConfigs = Object.entries(allowedInternalImports).map(([dir, allowed]) => ({
  name: `pepper/boundaries/${dir}`,
  files: [`${dir}/**/*.{ts,tsx,js,mjs}`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['@pepper/*', ...allowed.map((name) => `!@pepper/${name}`)],
            message: `${dir} ${
              allowed.length
                ? `may only import ${allowed.map((n) => `@pepper/${n}`).join(', ')}`
                : 'must not import other @pepper packages'
            } (layer rules, docs/plan/dependency-map.md).`,
          },
          {
            // `@pepper/runtime/instrument` and `@pepper/ai/config` are the extra entry points: the
            // `node --import` preload must not load what tracing patches (see
            // packages/runtime/src/instrument.ts), and the api's config reads the AI settings there.
            group: ['@pepper/*/*', '!@pepper/runtime/instrument', '!@pepper/ai/config'],
            message: 'Import packages through their public entry point, not deep paths.',
          },
        ],
      },
    ],
  },
}));

export default defineConfig(
  {
    name: 'pepper/ignores',
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/.next/**',
      '**/next-env.d.ts',
      '**/node_modules/**',
      'e2e/test-results/**',
      'e2e/playwright-report/**',
      'docs/**',
      // Claude Code's session tooling (hooks, skills' helper scripts), not product code (M2).
      '.claude/**',
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    name: 'pepper/typescript',
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js', '.pnpmfile.cjs', 'apps/web/postcss.config.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // Allowed only with an eslint-disable comment explaining why (CLAUDE.md code standards).
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // NestJS modules are decorated classes with only static `forRoot` factories.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    name: 'pepper/web',
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [nextPlugin.configs['core-web-vitals']],
    languageOptions: { globals: globals.browser },
    settings: { next: { rootDir: 'apps/web' } },
  },
  {
    // OWASP LLM10 (S26, ADR-0031): the AI's words and anything a card carries are rendered as
    // plain text. No raw HTML, and no Markdown renderer that could turn model text into links.
    name: 'pepper/no-raw-html',
    files: ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Render text as text (OWASP LLM10): never dangerouslySetInnerHTML.',
        },
        {
          selector: 'AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]',
          message: 'Render text as text (OWASP LLM10): never innerHTML.',
        },
        {
          selector:
            'ImportDeclaration[source.value=/markdown|^marked$|remark|rehype|sanitize-html/]',
          message: 'No Markdown or HTML renderers in the app: the AI’s text stays plain text.',
        },
      ],
    },
  },
  {
    name: 'pepper/web-service-worker',
    files: ['apps/web/public/sw.js'],
    languageOptions: { globals: globals.serviceworker, sourceType: 'script' },
  },
  {
    name: 'pepper/js-config-files',
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  comments.recommended,
  {
    name: 'pepper/disable-directives-need-reasons',
    rules: {
      // Every eslint-disable must say why, e.g. `// eslint-disable-next-line rule -- reason`.
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: [] }],
      '@eslint-community/eslint-comments/disable-enable-pair': ['error', { allowWholeFile: true }],
    },
  },
  ...boundaryConfigs,
  prettier,
);
