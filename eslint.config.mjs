import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage', 'storage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  { files: ['scripts/**', 'src/db/cli.ts', 'src/import/cli.ts', 'src/program/organise-cli.ts', 'src/config/env.ts'], rules: { 'no-console': 'off' } },
  { files: ['**/*.cjs'], languageOptions: { globals: { module: 'writable', __dirname: 'readonly' } } },
  { files: ['**/*.mjs'], languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly' } } },
);
