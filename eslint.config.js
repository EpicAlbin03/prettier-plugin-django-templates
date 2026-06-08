import js from '@eslint/js'
import vitest from '@vitest/eslint-plugin'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default [
  {
    ignores: ['coverage/**', 'dist/**', 'node_modules/**', 'out/**', 'src/melody-extension-core/**', 'src/melody-parser/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    },
    rules: {
      curly: 'error',
      'no-console': 'off',
      'no-var': 'error',
      'prefer-const': 'error'
    }
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unsafe-optional-chaining': 'off',
      'no-var': 'off',
      'prefer-const': 'off'
    }
  },
  {
    files: ['tests/**/*.ts', 'tests_config/**/*.ts', 'vitest.config.ts'],
    plugins: {
      vitest
    },
    languageOptions: {
      globals: {
        ...globals.node,
        ...vitest.environments.env.globals
      }
    },
    rules: {
      ...vitest.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off'
    }
  }
]
