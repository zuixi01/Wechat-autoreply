import { DatabaseSync } from 'node:sqlite'
import { lstat, realpath, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  createLedgerBackup,
  restoreLedgerBackup,
  verifyLedgerBackup
} from '../src/core/persistence/ledger-backup'
import { readLedgerRestoreContext } from '../src/core/persistence/ledger-restoration'
import { readLedgerRestoreInventory } from '../src/core/persistence/restore-inventory'

async function main(): Promise<void> {
  const { positionals, values, tokens } = parseArgs({
    allowPositionals: true,
    strict: true,
    tokens: true,
    options: {
      source: { type: 'string' },
      output: { type: 'string' },
      backup: { type: 'string' },
      scope: { type: 'string' },
      after: { type: 'string' },
      limit: { type: 'string' },
      basis: { type: 'string' },
      help: { type: 'boolean' }
    }
  })
  const optionsSeen = new Set<string>()
  for (const token of tokens)
    if (token.kind === 'option') {
      if (optionsSeen.has(token.name)) throw new Error('ledger_recovery_arguments_invalid')
      optionsSeen.add(token.name)
    }
  if (values.help || !positionals.length) {
    process.stdout.write(
      'Ledger recovery (offline; no chat or model calls)\nbackup --source <ledger.sqlite> --output <private-backup-root>\nverify --backup <snapshot-directory>\nrestore --backup <snapshot-directory> --output <new-directory>\ninspect-restoration --source <ledger.sqlite>\ninspect-inventory --source <ledger.sqlite> --scope <private-device-scope.json> [--after KEY] [--limit 1..100] [--basis SHA256]\nInventory is restored local metadata, not backup-after delivery evidence or restore permission.\nRestored ledgers require central reconciliation before execution.\n'
    )
    return
  }
  if (positionals.length !== 1) throw new Error('ledger_recovery_arguments_invalid')
  const command = positionals[0]
  if (
    command !== 'inspect-inventory' &&
    [values.scope, values.after, values.limit, values.basis].some((value) => value !== undefined)
  )
    throw new Error('ledger_recovery_arguments_invalid')
  if (
    (command === 'backup' && values.source && values.output && !values.backup) ||
    (command === 'inspect-restoration' && values.source && !values.output && !values.backup) ||
    (command === 'inspect-inventory' &&
      values.source &&
      values.scope &&
      !values.output &&
      !values.backup)
  ) {
    const path = resolve(values.source),
      info = await lstat(path),
      canonical = await realpath(path)
    const compare = (value: string): string =>
      process.platform === 'win32' ? value.toLowerCase() : value
    if (!info.isFile() || info.isSymbolicLink() || compare(path) !== compare(canonical))
      throw new Error('ledger_recovery_source_invalid')
    const source = new DatabaseSync(path, { readOnly: true })
    try {
      source.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON')
      if (command === 'backup') {
        const result = await createLedgerBackup(source, values.output!)
        process.stdout.write(JSON.stringify({ passed: true, command, ...result }) + '\n')
      } else if (command === 'inspect-inventory') {
        const scopePath = resolve(values.scope!),
          scopeInfo = await lstat(scopePath),
          scopeReal = await realpath(scopePath)
        if (
          !scopeInfo.isFile() ||
          scopeInfo.isSymbolicLink() ||
          scopeInfo.size > 8192 ||
          compare(scopePath) !== compare(scopeReal)
        )
          throw new Error('ledger_recovery_arguments_invalid')
        if (values.limit !== undefined && !/^[1-9]\d{0,2}$/.test(values.limit))
          throw new Error('ledger_recovery_arguments_invalid')
        const scopeBytes = await readFile(scopePath)
        if (scopeBytes.byteLength > 8192) throw new Error('ledger_recovery_arguments_invalid')
        const result = readLedgerRestoreInventory(source, JSON.parse(scopeBytes.toString('utf8')), {
          ...(values.after !== undefined ? { after: values.after } : {}),
          ...(values.limit !== undefined ? { limit: Number(values.limit) } : {}),
          ...(values.basis !== undefined ? { expectedBasisHash: values.basis } : {})
        })
        process.stdout.write(JSON.stringify({ passed: true, command, ...result }) + '\n')
      } else {
        const context = readLedgerRestoreContext(source)
        process.stdout.write(
          JSON.stringify({
            passed: true,
            command,
            context,
            requiresReconciliation: context !== null
          }) + '\n'
        )
      }
    } finally {
      source.close()
    }
  } else if (command === 'verify' && values.backup && !values.source && !values.output) {
    const manifest = await verifyLedgerBackup(values.backup)
    process.stdout.write(JSON.stringify({ passed: true, command, ...manifest }) + '\n')
  } else if (command === 'restore' && values.backup && values.output && !values.source) {
    const result = await restoreLedgerBackup(values.backup, values.output)
    process.stdout.write(JSON.stringify({ passed: true, command, ...result }) + '\n')
  } else throw new Error('ledger_recovery_arguments_invalid')
}
main().catch((error: unknown) => {
  const code =
    error instanceof Error && /^ledger_(backup|restore|recovery)_[a-z_]+$/.test(error.message)
      ? error.message
      : 'ledger_recovery_failed'
  process.stderr.write(code + '\n')
  process.exitCode = 1
})
