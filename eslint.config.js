import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';
export default ts.config(
  { ignores: ['dist/**', '**/dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
    },
  },
  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
);
