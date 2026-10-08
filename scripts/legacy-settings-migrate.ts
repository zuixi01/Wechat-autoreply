import { parseArgs } from 'node:util'
import { LegacySettingsArchive } from '../src/core/persistence/legacy-settings-archive'

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      source: { type: 'string' },
      archive: { type: 'string' },
      workspace: { type: 'string' },
      help: { type: 'boolean' }
    }
  })
  if (values.help || !positionals.length) {
    process.stdout.write(
      'Legacy settings drafts (offline; no chat or model calls)\nmigrate --source <settings.json> --archive <private-drafts.sqlite> --workspace <private-profile-id>\ninspect --archive <private-drafts.sqlite> --workspace <private-profile-id>\nOriginal backups can contain credentials. Drafts remain pending and unassigned.\n'
    )
    return
  }
  const command = positionals[0]
  if (
    positionals.length !== 1 ||
    !values.archive ||
    !values.workspace ||
    (command !== 'migrate' && command !== 'inspect') ||
    (command === 'migrate' ? !values.source : !!values.source)
  )
    throw new Error('legacy_settings_arguments_invalid')
  const archive = new LegacySettingsArchive(values.archive, values.workspace, {
    readOnly: command === 'inspect'
  })
  try {
    if (command === 'migrate') {
      const result = await archive.importFile(values.source!)
      process.stdout.write(JSON.stringify({ passed: true, command, ...result }) + '\n')
    } else {
      const drafts = archive.list(),
        kinds = { preferences: 0, mode: 0, relationship: 0 }
      for (const draft of drafts) kinds[draft.content.kind]++
      process.stdout.write(
        JSON.stringify({
          passed: true,
          command,
          drafts: drafts.length,
          kinds,
          automaticEnabled: false,
          identityVerified: false,
          reviewRequired: true
        }) + '\n'
      )
    }
  } finally {
    archive.close()
  }
}
main().catch((error: unknown) => {
  const code =
    error instanceof Error && /^legacy_settings_[a-z_]+$/.test(error.message)
      ? error.message
      : 'legacy_settings_failed'
  process.stderr.write(code + '\n')
  process.exitCode = 1
})
