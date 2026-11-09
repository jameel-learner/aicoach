// ESLint (flat config) for the whole monorepo. Formatting is Prettier's job; this catches bugs.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.wrangler/**',
      '**/.expo/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'apps/mobile/expo-env.d.ts',
      'packages/db/migrations/**',
      '**/worker-configuration.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node, ...globals.serviceworker },
    },
    rules: {
      // Unused values are bugs, but allow intentionally ignored ones (_x) and rest siblings.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['apps/admin-web/src/**/*.{ts,tsx}', 'apps/mobile/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // React Native loads bundled images/fonts with require('./file.png').
    files: ['apps/mobile/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-require-imports': [
        'error',
        { allow: ['\\.(png|jpe?g|gif|webp|svg|ttf|otf)$'] },
      ],
    },
  },
  {
    // Tests use loosely typed JSON fixtures.
    files: ['**/test/**/*.ts', '**/*.test.ts', '**/e2e/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
