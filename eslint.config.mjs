// @ts-check
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

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
  {
    // S1-1 (plan 6.5): Studio's components. Untrusted text is never set as HTML; React's escaping is the only path to the page.
    files: ['apps/studio/**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: false, sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Studio never sets HTML from text (plan 6.5). Render it as text, or add a reviewed sanitiser first.',
        },
      ],
    },
  },
];
