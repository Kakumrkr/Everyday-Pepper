// @ts-check
import { defineConfig } from 'eslint/config';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Layer boundaries (CLAUDE.md "Architecture rules", docs/plan/dependency-map.md).
 * Each package may import only the @floty packages listed for it; everything else is an error.
 * Add a row when a package is created.
 */
const allowedInternalImports = {
  'packages/config': [],
  'packages/contracts': [],
  'packages/db': ['contracts'],
  'packages/core': ['contracts', 'db'],
  'packages/modules/*': ['contracts', 'db', 'core'],
  'packages/templates/*': ['contracts'],
  'packages/ai': ['contracts', 'core'],
  'packages/integrations': ['contracts', 'core'],
  'packages/ui': ['contracts'],
};

const boundaryConfigs = Object.entries(allowedInternalImports).map(([dir, allowed]) => ({
  name: `floty/boundaries/${dir}`,
  files: [`${dir}/**/*.{ts,tsx,js,mjs}`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['@floty/*', ...allowed.map((name) => `!@floty/${name}`)],
            message: `${dir} ${
              allowed.length
                ? `may only import ${allowed.map((n) => `@floty/${n}`).join(', ')}`
                : 'must not import other @floty packages'
            } (layer rules, docs/plan/dependency-map.md).`,
          },
          {
            group: ['@floty/*/*'],
            message: 'Import packages through their public entry point, not deep paths.',
          },
        ],
      },
    ],
  },
}));

export default defineConfig(
  {
    name: 'floty/ignores',
    ignores: ['**/dist/**', '**/coverage/**', '**/.turbo/**', '**/node_modules/**', 'docs/**'],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    name: 'floty/typescript',
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js'] },
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
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    name: 'floty/js-config-files',
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  comments.recommended,
  {
    name: 'floty/disable-directives-need-reasons',
    rules: {
      // Every eslint-disable must say why, e.g. `// eslint-disable-next-line rule -- reason`.
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: [] }],
      '@eslint-community/eslint-comments/disable-enable-pair': ['error', { allowWholeFile: true }],
    },
  },
  ...boundaryConfigs,
  prettier,
);
