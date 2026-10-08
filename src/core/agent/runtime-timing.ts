import type { AgentProgressEvent } from './reliable-agent'
import type { CollectionTimingEvent } from './conversation-collector'
import type { ReplyTask } from '../../shared/contracts/task'

export interface RuntimePresentationReceipt {
  task: ReplyTask
  rowVersion: string
  receiptId: string
  webContentsId: number
  atMs: number
}

export interface RuntimeTimingSource {
  sourceMessageId: string
  sequence: number
  verified: boolean
}
/** Main-process metadata only. Renderer clocks and message bodies are never evidence. */
export type RuntimeTimingEvent = { runtimeInstanceId: string } & (
  | {
      kind: 'agent'
      event: AgentProgressEvent
      sources?: RuntimeTimingSource[]
      modelResolved?: string
    }
  | { kind: 'collection'; event: CollectionTimingEvent }
  | { kind: 'presentation'; event: RuntimePresentationReceipt }
)
