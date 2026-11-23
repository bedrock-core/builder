import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const interfaceDeclaration = {
  selector: ':matches(TSInterfaceDeclaration, ExportNamedDeclaration[declaration.type="TSInterfaceDeclaration"], ExportDefaultDeclaration[declaration.type="TSInterfaceDeclaration"])',
};

export default defineConfig([
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.bedrock-core/**', '**/.bds/**', 'coverage/**', 'packages/cli/templates/**'] },
  {
    files: ['**/*.{js,mjs,ts}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['packages/bedrock-types/types/registries.d.ts'],
    rules: {
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],
    },
  },
  {
    files: ['**/*.{js,mjs,ts}'],
    ...stylistic.configs.customize({ indent: 2, quotes: 'single', semi: true, braceStyle: '1tbs' }),
    rules: {
      ...stylistic.configs.customize({
        indent: 2,
        quotes: 'single',
        semi: true,
        braceStyle: '1tbs',
      }).rules,
      'curly': ['error', 'all'],
      '@stylistic/max-statements-per-line': ['error', { max: 1 }],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: ['const', 'let'], next: '*' },
        { blankLine: 'any', prev: ['const', 'let'], next: ['const', 'let'] },
        { blankLine: 'always', prev: '*', next: 'return' },
        { blankLine: 'always', prev: 'block-like', next: '*' },
        { blankLine: 'always', prev: '*', next: 'block-like' },
        { blankLine: 'always', prev: interfaceDeclaration, next: interfaceDeclaration },
      ],
    },
  },

  {
    files: ['packages/*/src/**/*.ts'],
    rules: {
      '@typescript-eslint/naming-convention': ['error', {
        selector: 'memberLike',
        modifiers: ['private'],
        format: ['camelCase'],
        leadingUnderscore: 'require',
      }],
    },
  },
]);
