import { open } from 'node:fs/promises'
import { Postgres } from '../src/database/postgres'
import { Administration, AdminError } from '../src/admin/administration'
import { assertDedicatedAdminRole } from '../src/admin/database-role'
import { RestoreReviewError } from '../src/admin/restore-review'
import { RestoreHistoryRecordError } from '../src/admin/restore-history'
import { RestoreHistoryError } from '../src/recovery/restore-history-proof'
import { RestoreResolutionError } from '../src/recovery/restore-resolution-basis'
import { RestoreRecoveryError } from '../src/recovery/restore-recovery-authorization'
import { executeAdminCommand, parseAdminCommand } from '../src/admin/command'
import { textGeneratorVersion } from '../src/generation/text-generator'
import { GenerationError } from '../src/generation/publication'
import { EvaluationAdmissionError } from '../src/admin/evaluation-admission'
import { writePrivateAdminOutput } from './private-admin-output'

async function readPublication(path: string, maximum = 1048576): Promise<unknown> {
  const handle = await open(path, 'r')
  try {
    if (!(await handle.stat()).isFile()) throw new Error('invalid_file')
    const bytes = Buffer.alloc(maximum + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > maximum) throw new Error('publication_too_large')
    return JSON.parse(bytes.subarray(0, length).toString('utf8'))
  } finally {
    await handle.close()
  }
}
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'Recovery completion audit: restore-completion-audit --tenant ID --account ID. Reads every restoration case under the authenticated account lock; no admission, resume, customer bodies or model requests.\n'
    )
    process.stdout.write(
      'History evidence: record-restore-history-proof --tenant ID --account ID --case UUID --upload UUID --file PATH; restore-history-proof --tenant ID --account ID --case UUID --proof UUID. Execution review: restore-execution-review --tenant ID --account ID --case UUID --review UUID. Requires independent maintenance requirements; receipts never authorize recovery.\n'
    )
    process.stdout.write(
      'Recovery preparation: restore-resolution-basis --tenant ID --account ID --case UUID --review UUID; restore-recovery-preview --tenant ID --account ID --case UUID --upload UUID --review UUID; restore-recovery-authorization --tenant ID --account ID --case UUID --authorization UUID. Independent maintenance approval, durable target application and central completion are still required; no automatic resume.\n'
    )
    process.stdout.write(
      'Restoration: open-restore-review --file PATH; restore-reviews; restore-review --case ID; restore-review-permits --case ID [--after PERMIT_ID] [--limit 1..100]; restore reviews never resume devices.\n' +
        'Restore declarations: restore-pause-reports --case ID [--after CHALLENGE_UUID] [--limit 1..100]; restore-pause-report --case ID --challenge ID. Historical receipts do not prove current or all-device physical stop.\n' +
        'Restore comparison: restore-permit-audit --case ID [--after PERMIT_ID] [--limit 1..100] [--basis SHA256]. Central metadata only; expired issuance is unresolved; no restore release.\n' +
        'Restore review: restore-rulings --case ID --upload ID [--limit 1..100] [--after SUBJECT --basis SHA256 --rulings SHA256]; record-restore-ruling --case ID --upload ID --file PATH. Explicit reviewed evidence; corrections require previous ID.\n' +
        'Restore decisions: seal-restore-decision --case ID --upload ID --file PATH; restore-decision --case ID --upload ID --decision ID. Complete quarantine review only; local application and central acknowledgement still required.\n' +
        'Commands: accounts | provision | enroll | publish | pause | resume | revoke | unresolved\n' +
        'Runtime status: runtime-status [--account ID] [--after CURSOR] [--limit 1..100]. Recent device declarations, not send authority or verified physical stops.\n' +
        'Purpose-bound pause: request-pause --account ID [--request UUID]; pause-request --account ID [--request UUID]. Confirmation details remain scoped runtime declarations.\n' +
        'Enterprise pause: request-pause-all [--request UUID]; pause-all-request --request UUID; pause-all-accounts --request UUID [--after CURSOR] [--limit 1..100]. Frozen targets, no automatic resume or physical-stop authority.\n' +
        'Evaluation: freeze-evaluation | approve-evaluation | evaluations | revoke-evaluation\n' +
        'Learning: prepare-learning --account ID --file TEMPLATE --out .local/PATH.json. Fresh version-bound private draft; never publishes or grants automatic replies.\n' +
        'Reconciliation: open-reconciliation | reconciliations | reconciliation | record-reconciliation-note | decide-reconciliation\n' +
        'request-seals: --account ID (permanent request tombstones and application acknowledgments).\n' +
        'model-limits: --account ID; set-model-limits: --account ID --file PATH (max 1 KiB).\n' +
        'model-runs: --account ID --task ID; model-usage: --account ID --date YYYY-MM-DD (UTC).\n' +
        'open-reconciliation: --account ID --permit ID; reconciliation: --account ID --case UUID.\n' +
        'record-reconciliation-note: --account ID --case UUID --file PATH (max 8 KiB).\n' +
        'decide-reconciliation: --account ID --case UUID --file PATH (max 8 KiB). Requires matching device proof and reviewed note.\n' +
        'Cases pause new admission; notes do not settle permits or acknowledge device stop.\n' +
        'Offline: generator-version (configured endpoint/model fingerprint; no API request).\n' +
        'Required: --tenant ID. Account commands: --account ID.\n' +
        'provision: --employee ID --platform wechat|wework; publish: --file PATH; revoke: --agent ID.\n' +
        'freeze-evaluation: --file PATH; approve-evaluation: --run ID --file PATH; revoke-evaluation: --approval ID.\n' +
        'Uses ADMIN_DATABASE_URL only. enroll returns a secret one-use code to stdout.\n'
    )
    return
  }
  if (args.length === 1 && args[0] === 'generator-version') {
    process.stdout.write(
      JSON.stringify({ textGeneratorVersion: configuredGeneratorVersion() }) + '\n'
    )
    return
  }
  const command = parseAdminCommand(args)
  const connection = process.env.ADMIN_DATABASE_URL
  if (!connection) throw new AdminError('DENIED')
  let expectedGenerator: string | undefined
  if (
    ['prepare-learning', 'publish', 'resume', 'freeze-evaluation', 'approve-evaluation'].includes(
      command.command
    )
  ) {
    expectedGenerator = configuredGeneratorVersion()
  }
  const db = new Postgres(connection)
  try {
    await assertDedicatedAdminRole(db)
    const result = await executeAdminCommand(
      new Administration(db, expectedGenerator),
      command,
      (path) =>
        readPublication(
          path,
          command.command === 'set-model-limits'
            ? 1024
            : command.command === 'approve-evaluation'
              ? 8 * 1048576
              : [
                    'record-reconciliation-note',
                    'decide-reconciliation',
                    'record-restore-evidence',
                    'record-restore-ruling',
                    'seal-restore-decision',
                    'open-restore-review'
                  ].includes(command.command)
                ? 8192
                : 1048576
        ),
      writePrivateAdminOutput
    )
    process.stdout.write(JSON.stringify(result) + '\n')
  } finally {
    await db.close()
  }
}
function configuredGeneratorVersion(): string {
  const baseUrl = process.env.TEXT_MODEL_BASE_URL,
    model = process.env.TEXT_MODEL_ID,
    expectedModel = process.env.TEXT_MODEL_EXPECTED_ID
  if (!baseUrl || !model || !expectedModel) throw new AdminError('CONFIGURATION_UNAVAILABLE')
  return textGeneratorVersion({ baseUrl, model, expectedModel })
}
main().catch((error) => {
  const code =
    error instanceof AdminError ||
    error instanceof RestoreReviewError ||
    error instanceof RestoreHistoryRecordError ||
    error instanceof RestoreHistoryError ||
    error instanceof RestoreResolutionError ||
    error instanceof RestoreRecoveryError ||
    error instanceof GenerationError ||
    error instanceof EvaluationAdmissionError
      ? error.code
      : 'ADMIN_OPERATION_FAILED'
  // Never include database URLs, file contents, enrollment codes or raw PG errors.
  process.stderr.write(JSON.stringify({ success: false, code }) + '\n')
  process.exitCode = 1
})
