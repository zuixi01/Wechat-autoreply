import { ReplyTaskSchema, type ReplyTask } from '../../shared/contracts/task'
import { stripLearningBinding } from '../../shared/contracts/learning-task'
import { hashContext } from './hashes'

/** The trusted transport may add only the three binding fields before ledger.begin. */
export function parsePreparedGenerationTask(value: unknown, original: ReplyTask): ReplyTask {
  const task = ReplyTaskSchema.parse(value)
  if (task.memoryCorpusVersion === undefined) throw new Error('prepared_task_binding_missing')
  if (hashContext(stripLearningBinding(task)) !== hashContext(stripLearningBinding(original)))
    throw new Error('prepared_task_changed')
  return task
}
