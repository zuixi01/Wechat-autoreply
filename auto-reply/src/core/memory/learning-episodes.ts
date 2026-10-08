import type { LearningEpisode } from '../../shared/contracts/learning-memory'

export function episodeSearchText(episode: LearningEpisode): string {
  return [
    episode.topic,
    ...episode.messages.map((message) => message.text),
    episode.correction ?? '',
    episode.correctionReason ?? ''
  ].join('\n')
}

/** Bounded quoted data, never an instruction or a source of current business facts. */
export function episodeExcerpt(episode: LearningEpisode): {
  episodeId: string
  topic: string
  outcome: LearningEpisode['outcome']
  messages: Pick<LearningEpisode['messages'][number], 'role' | 'text'>[]
  correction: string | undefined
  correctionReason: string | undefined
} {
  return {
    episodeId: episode.id,
    topic: episode.topic.slice(0, 160),
    outcome: episode.outcome,
    messages: episode.messages
      .slice(-3)
      .map((message) => ({ role: message.role, text: message.text.slice(0, 120) })),
    correction: episode.correction?.slice(0, 240),
    correctionReason: episode.correctionReason?.slice(0, 120)
  }
}
