import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      '.local/**',
      'coverage/**',
      'test-results/**',
      'native/**/bin/**',
      'native/**/obj/**'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  eslintConfigPrettier,
  {
    files: ['**/*.{js,mjs,cjs,jsx}'],
    // JS cannot express TS return annotations; keep this rule on TypeScript only.
    // https://typescript-eslint.io/rules/explicit-function-return-type/#configuring-in-a-mixed-jsts-codebase
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' }
  },
  {
    files: ['tests/**/*.ts'],
    // Vitest fixtures infer precise mocked return types; production remains explicit.
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' }
  }
)
