import type { ReplyService, ReplyCandidate } from './reliable-agent'
import type { ContextMessage } from '../../shared/contracts/context'
import type { ReplyTask } from '../../shared/contracts/task'
import type { GenerationInput, GenerationResult } from '../../shared/contracts/generation'
import { parseGenerationInput, parseGenerationResult } from '../reply/generation-validation'
import { parsePreparedGenerationTask } from '../reply/learning-task-binding'

export interface GenerationTransport {
  prepareGeneration?(input: GenerationInput, signal?: AbortSignal): Promise<ReplyTask>
  generateCandidate(input: GenerationInput, signal?: AbortSignal): Promise<GenerationResult>
}
/** The injected transport keeps device credentials in the Electron main process. */
export class RemoteReplyService implements ReplyService {
  constructor(
    private readonly transport: GenerationTransport,
    private readonly now: () => number = Date.now
  ) {}
  async prepare(
    task: ReplyTask,
    inbound: string[],
    isCurrent: () => boolean,
    signal: AbortSignal,
    context?: ContextMessage[]
  ): Promise<ReplyTask> {
    if (!context || signal.aborted || !isCurrent()) throw new Error('reply_task_unavailable')
    if (!this.transport.prepareGeneration) return structuredClone(task)
    const input = parseGenerationInput(structuredClone({ task, inbound, context }))
    const prepared = parsePreparedGenerationTask(
      await this.transport.prepareGeneration(input, signal),
      task
    )
    if (signal.aborted || !isCurrent()) throw new Error('reply_task_obsolete')
    return prepared
  }
  async generate(
    task: ReplyTask,
    inbound: string[],
    isCurrent: () => boolean,
    signal: AbortSignal,
    context?: ContextMessage[]
  ): Promise<ReplyCandidate> {
    if (!context || signal.aborted || !isCurrent()) throw new Error('reply_task_unavailable')
    const input = parseGenerationInput(structuredClone({ task, inbound, context }))
    const result = parseGenerationResult(
      await this.transport.generateCandidate(input, signal),
      task,
      this.now()
    )
    if (signal.aborted || !isCurrent()) throw new Error('reply_task_obsolete')
    return result
  }
}
