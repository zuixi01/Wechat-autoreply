import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
const policy = createRequire(import.meta.url)('../../scripts/package-inventory-policy.cjs') as {
  assertPackageInventory: (paths: string[]) => void
}
describe('shipped application inventory', () => {
  it('allows compiled app, published resources, dependencies and required notices', () => {
    expect(() =>
      policy.assertPackageInventory([
        '/out/main/index.js',
        '/resources/providers/volcengine-ark/manifest.json',
        '/node_modules/zod/package.json',
        '/package.json',
        '/LICENSE',
        '/NOTICE'
      ])
    ).not.toThrow()
  })
  it.each([
    'dist/old/app.asar',
    '.local/reports/test.json',
    'src/main/index.ts',
    'sentpredict/train.py',
    'backup/settings.json',
    'tsconfig.node.tsbuildinfo',
    'node_modules/pkg/.env',
    'out/main/.npmrc'
  ])('refuses %s', (path) => {
    expect(() => policy.assertPackageInventory([path])).toThrow('private_build_files_in_package')
  })
})
