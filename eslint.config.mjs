// @ts-check
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.tsbuildinfo'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: false,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Tests, fixtures, benchmarks and example/demo programs legitimately print
    // and use loose typing for deliberately malformed inputs.
    files: [
      '**/test/**/*.ts',
      '**/tests/**/*.ts',
      '**/*.test.ts',
      '**/bench/**/*.ts',
      'examples/**/*.ts',
      '**/examples/**/*.ts',
      'scripts/**/*.ts',
    ],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Command-line entry points and demo scripts write to stdout by design.
    files: ['apps/cli/**/*.ts', '**/demo*.ts', '**/scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
];
