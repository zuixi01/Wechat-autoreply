import { ipcMain } from 'electron'
import { z } from 'zod'
import { rendererTrust } from './trusted-ipc'
import type { LearningService } from '../services/learning-service'
import {
  LearningActionSchema,
  LearningCorrectionSchema,
  LearningSettingsPatchSchema,
  LearningResultSchema,
  LearningHumanFeedbackSchema,
  LearningDesktopRequests,
  type LearningMemoryDesktopApi,
  type LearningWorkbenchSnapshot
} from '../../shared/contracts/learning-desktop'
import {
  LearningEpisodeSchema,
  MemoryScopeSchema,
  type LearningEpisode,
  type MemoryScope
} from '../../shared/contracts/learning-memory'
import {
  LearningModelDirectorySchema,
  assertLearningReviewSelection,
  type LearningModelDirectory
} from '../../shared/contracts/learning-model-directory'

export function registerLearningIpc(
  rendererFile: string,
  developerOrigin: string | undefined,
  service: LearningService,
  defaultScope: () => MemoryScope,
  resolveBackend?: (scope?: MemoryScope) => LearningMemoryDesktopApi | null,
  modelDirectory?: () => LearningModelDirectory,
  lifecycle?: {
    observed(episode: LearningEpisode): void
    forgetLocal(scope: MemoryScope, run: () => void): Promise<void>
  }
): void {
  const trust = rendererTrust(rendererFile, developerOrigin),
    store = service.store
  const Id = z.string().trim().min(1).max(128)
  const methods = {
    episode: 'episode',
    'model-directory': 'modelDirectory',
    snapshot: 'snapshot',
    detail: 'detail',
    settings: 'settings',
    act: 'act',
    correct: 'correct',
    result: 'confirmResult',
    feedback: 'feedback',
    review: 'review',
    cancel: 'cancel',
    'forget-scope': 'forgetScope',
    manual: 'manual',
    'assign-legacy': 'assignLegacy',
    calibration: 'calibration',
    'import-calibration': 'importCalibration',
    validate: 'validate',
    curate: 'curate',
    search: 'searchEpisodes',
    reports: 'reports'
  } as const satisfies Record<keyof typeof LearningDesktopRequests, keyof LearningMemoryDesktopApi>
  const handle = (
    channel: keyof typeof LearningDesktopRequests,
    run: (input: unknown) => unknown
  ): void => {
    ipcMain.handle(`learning:${channel}`, (event, input: unknown) => {
      trust(event)
      const value = LearningDesktopRequests[channel].parse(
        channel === 'snapshot' ? (input ?? {}) : input
      )
      const backend = resolveBackend?.(value.scope)
      const observe = (result: unknown): unknown => {
        if (!lifecycle) return result
        if (channel === 'episode') lifecycle.observed(LearningEpisodeSchema.parse(result))
        if (channel === 'snapshot') {
          for (const episode of (result as LearningWorkbenchSnapshot).episodes)
            lifecycle.observed(LearningEpisodeSchema.parse(episode))
        }
        return result
      }
      if (backend) {
        const method = backend[methods[channel]] as (input: unknown) => unknown
        return Promise.resolve(method.call(backend, value)).then(observe)
      }
      return observe(run(value))
    })
  }
  handle('episode', (input) => {
    const { scope, episodeId } = LearningDesktopRequests.episode.parse(input)
    service.assertScope(scope)
    return store.episode(scope, episodeId)
  })
  handle('model-directory', (input) => {
    const { scope } = LearningDesktopRequests['model-directory'].parse(input)
    service.assertScope(scope)
    return LearningModelDirectorySchema.parse(modelDirectory?.() ?? [])
  })
  handle('snapshot', (input) => {
    const value = z.strictObject({ scope: MemoryScopeSchema.optional() }).parse(input ?? {})
    const scope = service.assertScope(value.scope ?? defaultScope())
    const result: LearningWorkbenchSnapshot = {
      scope,
      scopes: service.scopes(),
      settings: store.settings(scope),
      memories: store
        .list(scope)
        .map((record) => ({ record, metrics: store.metrics(scope, record.id) })),
      episodes: store.episodes(scope).slice(0, 100),
      jobs: store.jobs.list(scope).slice(0, 100),
      usage: store.jobs.usage(scope),
      unassigned: store.unassigned()
    }
    return result
  })
  handle('detail', (input) => {
    const { scope, id } = z.strictObject({ scope: MemoryScopeSchema, id: Id }).parse(input)
    service.assertScope(scope)
    return { memory: store.get(scope, id), history: store.history(scope, id) }
  })
  handle('settings', (input) => {
    const { scope, patch } = z
      .strictObject({ scope: MemoryScopeSchema, patch: LearningSettingsPatchSchema })
      .parse(input)
    service.assertScope(scope)
    if (patch.reviewModelId !== undefined)
      assertLearningReviewSelection(
        patch.reviewModelId,
        LearningModelDirectorySchema.parse(modelDirectory?.() ?? [])
      )
    return store.settings(scope, patch)
  })
  handle('act', (input) => {
    const value = LearningActionSchema.parse(input),
      scope = service.assertScope(value.scope)
    switch (value.action) {
      case 'propose':
        return store.propose(scope, {
          content: value.content,
          evidence: value.evidence,
          reason: value.reason,
          expiresAt: value.expiresAt,
          source: 'manual'
        })
      case 'revise':
        return store.revise(scope, value.id, value.expectedRevision, {
          content: value.content,
          evidence: value.evidence,
          reason: value.reason,
          expiresAt: value.expiresAt,
          source: 'human'
        })
      case 'activate':
        return store.activate(scope, value.id, value.expectedRevision)
      case 'rollback':
        return store.rollback(scope, value.id, value.expectedRevision, value.targetRevision)
      case 'pin':
        store.setPinned(scope, value.id, value.expectedRevision, value.pinned)
        break
      case 'archive':
        store.archive(scope, value.id, value.expectedRevision, 'human')
        break
      case 'restore':
        store.restore(scope, value.id, value.expectedRevision)
        break
      case 'forget':
        store.forget(scope, value.id, value.expectedRevision)
        return null
    }
    return store.get(scope, value.id)
  })
  handle('correct', (input) => {
    const { scope, episodeId, ...correction } = LearningCorrectionSchema.parse(input)
    return service.correct(scope, episodeId, correction)
  })
  handle('result', (input) => {
    const { scope, episodeId, ...result } = LearningResultSchema.parse(input)
    return service.confirmResult(scope, episodeId, result)
  })
  handle('feedback', (input) => {
    const { scope, episodeId, ...feedback } = LearningHumanFeedbackSchema.parse(input)
    return service.humanFeedback(scope, episodeId, feedback)
  })
  handle('review', (input) => {
    const { scope, episodeId, sourceId } = z
      .strictObject({ scope: MemoryScopeSchema, episodeId: Id, sourceId: Id })
      .parse(input)
    return { jobId: service.review(scope, episodeId, sourceId) }
  })
  handle('cancel', (input) => {
    const { scope, jobId } = z.strictObject({ scope: MemoryScopeSchema, jobId: Id }).parse(input)
    service.assertScope(scope)
    store.jobs.cancel(scope, jobId)
  })
  handle('forget-scope', (input) => {
    const { scope } = z.strictObject({ scope: MemoryScopeSchema }).parse(input)
    service.assertScope(scope)
    if (lifecycle) return lifecycle.forgetLocal(scope, () => store.forgetScope(scope))
    return store.forgetScope(scope)
  })
  handle('manual', (input) => {
    const { scope, ...value } = LearningDesktopRequests.manual.parse(input)
    service.assertScope(scope)
    return store.teach(scope, value)
  })
  handle('assign-legacy', (input) => {
    const { scope, legacyId, sourceId } = z
      .strictObject({ scope: MemoryScopeSchema, legacyId: Id, sourceId: Id })
      .parse(input)
    service.assertScope(scope)
    return store.assignLegacy(scope, legacyId, sourceId)
  })
  handle('calibration', (input) => {
    const { scope } = LearningDesktopRequests.calibration.parse(input)
    service.assertScope(scope)
    return store.validation.calibration(scope)
  })
  handle('import-calibration', (raw) => {
    const { scope, input } = LearningDesktopRequests['import-calibration'].parse(raw)
    service.assertScope(scope)
    return store.validation.importCalibration(
      scope,
      input,
      `local-human:${scope.workspaceId}`.slice(0, 128)
    )
  })
  handle('validate', (input) => {
    const { scope, id, expectedRevision } = LearningDesktopRequests.validate.parse(input)
    service.assertScope(scope)
    return service.validateCandidate(scope, id, expectedRevision)
  })
  handle('curate', (input) => {
    const { scope, dryRun } = LearningDesktopRequests.curate.parse(input)
    service.assertScope(scope)
    return service.curate(scope, dryRun)
  })
  handle('search', (input) => {
    const { scope, query, limit } = LearningDesktopRequests.search.parse(input)
    service.assertScope(scope)
    return store.searchEpisodeHistory(scope, query, limit)
  })
  handle('reports', (input) => {
    const { scope } = LearningDesktopRequests.reports.parse(input)
    service.assertScope(scope)
    return {
      validation: store.validation.reportsForScope(scope),
      curation: store.curation.reports(scope).slice(0, 100)
    }
  })
}
