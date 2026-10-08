import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, transform } from 'esbuild'
import ts from 'typescript'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const slash = (path) => path.replaceAll('\\', '/')
const ordered = (value) =>
  JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))

/** Preserve deployed module paths: learning evaluation hashes neighboring deployed files. */
export async function buildServerRelease() {
  const expectedNode = (await readFile(join(root, '.node-version'), 'utf8')).trim()
  if (process.versions.node !== expectedNode) throw new Error('server_build_node_version_mismatch')
  const captured = new Map()
  async function capture(path) {
    const absolute = resolve(root, path)
    const name = slash(relative(root, absolute))
    if (name.startsWith('../') || name.includes('/node_modules/') || name.startsWith('.local/'))
      throw new Error('server_build_source_outside_allowlist')
    if (!captured.has(name)) {
      const info = await lstat(absolute)
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (await realpath(absolute)).toLowerCase() !== absolute.toLowerCase()
      )
        throw new Error('server_build_source_not_regular')
      captured.set(name, await readFile(absolute))
    }
    return captured.get(name)
  }
  const sourcePackage = JSON.parse((await capture('server/package.json')).toString('utf8'))
  const lock = JSON.parse((await capture('server/package-lock.json')).toString('utf8'))
  const dependencies = sourcePackage.dependencies
  if (
    ordered(dependencies) !== ordered(lock.packages[''].dependencies) ||
    ordered(sourcePackage.devDependencies) !== ordered(lock.packages[''].devDependencies)
  )
    throw new Error('server_build_lock_mismatch')
  const scripts = [
    'admin.ts',
    'admin-server.ts',
    'jev-calibrate.ts',
    'jev-check.ts',
    'jev-evaluate.ts',
    'jev-replay.ts',
    'jev-settlements.ts',
    'memory-replay.ts',
    'prepare-knowledge.ts',
    'restore-history-maintenance.ts',
    'server-check.ts'
  ]
    .sort()
    .map((name) => `server/scripts/${name}`)
  const entries = [
    'server/src/index.ts',
    ...scripts,
    'evals/memory/replay.ts',
    'evals/memory/replay-http.ts'
  ]
  await capture('server/tsconfig.json')
  await capture('server/build-release.mjs')
  await capture('.node-version')
  const graph = await build({
    absWorkingDir: root,
    entryPoints: entries,
    outdir: 'unused-server-graph',
    bundle: true,
    write: false,
    metafile: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node24',
    logLevel: 'silent',
    tsconfig: join(root, 'server/tsconfig.json'),
    plugins: [
      {
        name: 'capture-server-sources',
        setup(builder) {
          builder.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
            const name = slash(relative(root, path))
            if (
              !/^(server\/(src|scripts)|src\/(core|shared)|evals\/(jev|memory))\/.+\.ts$/.test(name)
            )
              throw new Error('server_build_module_outside_allowlist')
            return { contents: (await capture(name)).toString('utf8'), loader: 'ts' }
          })
        }
      }
    ]
  })
  if (graph.warnings.length) throw new Error('server_build_graph_warning')
  const modules = new Set(Object.keys(graph.metafile.inputs).map(slash))
  const externals = new Set()
  // Input metadata also lists erased type-only imports as external; only emitted imports run.
  for (const input of Object.values(graph.metafile.outputs)) {
    for (const item of input.imports) {
      if (item.external) {
        const name = item.path
        if (
          !builtins.has(name) &&
          !Object.keys(dependencies).some((pkg) => name === pkg || name.startsWith(pkg + '/'))
        )
          throw new Error('server_build_undeclared_dependency')
        externals.add(name)
      }
    }
  }
  const outputFiles = new Map()
  function rewritten(name, code) {
    const source = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    function specifier(text) {
      if (!text.startsWith('.')) return text
      if (/[?#]/.test(text)) throw new Error('server_build_unsupported_import')
      const target = slash(relative(root, resolve(root, dirname(name), text)))
      const candidates = [
        target,
        target + '.ts',
        target + '/index.ts',
        target.replace(/\.js$/, '.ts')
      ]
      const found = candidates.find((candidate) => modules.has(candidate))
      if (!found || !found.endsWith('.ts')) throw new Error('server_build_unresolved_module')
      let path = slash(relative(dirname(name), found.replace(/\.ts$/, '.js')))
      if (!path.startsWith('.')) path = './' + path
      return path
    }
    const result = ts.transform(source, [
      (context) => {
        function visit(node) {
          if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier
          ) {
            if (!ts.isStringLiteral(node.moduleSpecifier))
              throw new Error('server_build_dynamic_module')
            const literal = ts.factory.createStringLiteral(specifier(node.moduleSpecifier.text))
            return ts.isImportDeclaration(node)
              ? ts.factory.updateImportDeclaration(
                  node,
                  node.modifiers,
                  node.importClause,
                  literal,
                  node.attributes
                )
              : ts.factory.updateExportDeclaration(
                  node,
                  node.modifiers,
                  node.isTypeOnly,
                  node.exportClause,
                  literal,
                  node.attributes
                )
          }
          if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
          ) {
            if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]))
              throw new Error('server_build_dynamic_module')
            return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [
              ts.factory.createStringLiteral(specifier(node.arguments[0].text))
            ])
          }
          // String-only references used by deploymentVersion are not import edges.
          if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            ['implementationHash', 'deploymentVersion'].includes(node.expression.text)
          ) {
            for (const arg of node.arguments.filter(ts.isArrayLiteralExpression))
              for (const item of arg.elements) {
                if (!ts.isStringLiteral(item)) throw new Error('server_build_dynamic_fingerprint')
                specifier(item.text)
              }
          }
          return ts.visitEachChild(node, visit, context)
        }
        return (node) => ts.visitNode(node, visit)
      }
    ])
    try {
      return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(result.transformed[0])
    } finally {
      result.dispose()
    }
  }
  for (const name of [...modules].sort()) {
    if (!/^(server\/(src|scripts)|src\/(core|shared)|evals\/(jev|memory))\/.+\.ts$/.test(name))
      throw new Error('server_build_module_outside_allowlist')
    const bytes = await capture(name)
    const compiled = await transform(bytes.toString('utf8'), {
      loader: 'ts',
      format: 'esm',
      target: 'node24',
      sourcefile: name,
      legalComments: 'inline'
    })
    if (compiled.warnings.length) throw new Error('server_build_transform_warning')
    outputFiles.set(name.replace(/\.ts$/, '.js'), Buffer.from(rewritten(name, compiled.code)))
  }
  const runtimeScripts = {
    start: 'node server/src/index.js',
    check: 'node server/scripts/server-check.js',
    admin: 'node server/scripts/admin.js',
    'admin:serve': 'node server/scripts/admin-server.js',
    'eval:jev': 'node server/scripts/jev-replay.js',
    'jev:settlements': 'node server/scripts/jev-settlements.js',
    'jev:check': 'node server/scripts/jev-check.js',
    'memory:replay': 'node server/scripts/memory-replay.js',
    'knowledge:prepare': 'node server/scripts/prepare-knowledge.js'
  }
  outputFiles.set(
    'package.json',
    Buffer.from(JSON.stringify({ ...sourcePackage, scripts: runtimeScripts }, null, 2) + '\n')
  )
  outputFiles.set('package-lock.json', await capture('server/package-lock.json'))
  const migrations = (await readdir(join(root, 'server/migrations')))
    .filter((name) => /^\d{3}-.+\.sql$/.test(name))
    .sort()
  if (!migrations.length) throw new Error('server_build_migrations_missing')
  for (const name of migrations)
    outputFiles.set(`server/migrations/${name}`, await capture(`server/migrations/${name}`))
  for (const [source, target] of [
    ['server/.env.example', '.env.example'],
    ['server/deployment.zh-CN.md', 'README.md'],
    ['LICENSE', 'LICENSE']
  ])
    outputFiles.set(target, await capture(source))
  // Shared checkout may change during compilation; such a candidate must never be promoted.
  const finalMigrations = (await readdir(join(root, 'server/migrations')))
    .filter((name) => /^\d{3}-.+\.sql$/.test(name))
    .sort()
  if (JSON.stringify(migrations) !== JSON.stringify(finalMigrations))
    throw new Error('server_build_migration_inventory_changed')
  for (const [name, bytes] of captured)
    if (hash(await readFile(join(root, name))) !== hash(bytes))
      throw new Error('server_build_source_changed')
  const id = randomUUID()
  const directory = join(root, '.local/server-releases', id)
  await mkdir(dirname(directory), { recursive: true })
  await mkdir(directory)
  const manifest = {
    schemaVersion: 1,
    id,
    createdAt: new Date().toISOString(),
    node: expectedNode,
    kind: 'server-deployment-candidate',
    productionReady: false,
    releaseAuthorized: false,
    dependencies,
    externalImports: [...externals].sort(),
    entries,
    sources: [...captured].map(([path, bytes]) => ({ path, sha256: hash(bytes) })),
    files: [...outputFiles].map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: hash(bytes)
    }))
  }
  for (const [name, bytes] of outputFiles) {
    const path = join(directory, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes, { flag: 'wx' })
  }
  await writeFile(
    join(directory, 'release-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    { flag: 'wx' }
  )
  return {
    directory,
    id,
    modules: modules.size,
    migrations: migrations.length,
    productionReady: false
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('server_build_arguments_invalid')
  console.log(JSON.stringify(await buildServerRelease(), null, 2))
}
