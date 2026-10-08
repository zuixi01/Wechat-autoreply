import type { Scope } from '../auth/account-authority'
import type { Publication } from '../generation/publication'
import type { GenerationInput } from '../../../src/shared/contracts/generation'
import { parseGenerationInput } from '../../../src/core/reply/generation-validation'
import { hashContext } from '../../../src/core/reply/hashes'
import type { EnterpriseMemoryReplayPacket } from './learning-memory-replay'

/** Main-host input only. Matching frozen data is not a native-platform attestation. */
export function parseForegroundEvaluationInput(
  raw: unknown,
  scope: Scope,
  publication: Publication,
  item: EnterpriseMemoryReplayPacket['input']['cases'][number],
  now: number
): GenerationInput {
  const input = parseGenerationInput(raw),
    task = input.task
  if (
    task.identity.tenantId !== scope.tenant_id ||
    task.identity.employeeId !== scope.employee_id ||
    task.identity.accountId !== scope.account_id ||
    task.identity.agentId !== scope.agent_id ||
    task.identity.platform !== scope.platform ||
    task.conversationId !== item.conversationId ||
    hashContext(input.inbound) !== hashContext(item.inbound) ||
    task.configVersion !== publication.configuration.configVersion ||
    task.knowledgeVersion !== publication.configuration.knowledgeVersion ||
    task.decisionPolicyVersion !== publication.policy.version ||
    task.questionSetVersion !== publication.policy.questionSetVersion ||
    task.createdAt > now ||
    task.expiresAt <= now ||
    task.memorySnapshotHash !== undefined ||
    task.learningContextVersion !== undefined ||
    task.memoryCorpusVersion !== undefined
  )
    throw new Error('evaluation_foreground_input_conflict')
  if (
    item.context
      ? hashContext(input.context) !== hashContext(item.context)
      : input.context.length !== item.inbound.length ||
        input.context.some(
          (message, index) =>
            message.direction !== 'inbound' ||
            message.kind !== 'text' ||
            message.text !== item.inbound[index]
        )
  )
    throw new Error('evaluation_foreground_context_conflict')
  return input
}

/** Bound host rendezvous. A stalled/late callback cannot start another paid request. */
export async function foregroundHostOperation<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  timeoutMs: number
): Promise<T> {
  if (signal.aborted) throw new Error('evaluation_cancelled')
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
  try {
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('evaluation_cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => reject(new Error('evaluation_foreground_timeout')), timeoutMs)
    })
    const result = await Promise.race([
      Promise.resolve().then(() => {
        if (signal.aborted) throw new Error('evaluation_cancelled')
        return operation()
      }),
      interrupted
    ])
    if (signal.aborted) throw new Error('evaluation_cancelled')
    return result
  } finally {
    if (timer) clearTimeout(timer)
    if (abort) signal.removeEventListener('abort', abort)
  }
}
