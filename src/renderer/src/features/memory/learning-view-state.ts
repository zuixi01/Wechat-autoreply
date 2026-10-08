import type { LearningWorkbenchSnapshot } from '../../../../shared/contracts/learning-desktop'
import type { MemoryScope } from '../../../../shared/contracts/learning-memory'

export function learningScopeKey(scope?: MemoryScope): string {
  return scope
    ? JSON.stringify([
        scope.workspaceId,
        scope.platform,
        scope.tenantId ?? null,
        scope.accountId ?? null,
        scope.conversationId ?? null
      ])
    : 'default'
}

export function learningScopeOptions(snapshot: LearningWorkbenchSnapshot): MemoryScope[] {
  const owned = snapshot.scope
  const enterprise = Boolean(
    owned.tenantId || owned.accountId || owned.workspaceId.startsWith('enterprise:')
  )
  if (enterprise && (!owned.tenantId || !owned.accountId)) return []
  const choices: MemoryScope[] = enterprise
    ? []
    : (['wechat', 'wework', 'generic'] as const).map((platform) => ({
        workspaceId: owned.workspaceId,
        platform
      }))
  const authorized = [owned, ...choices, ...snapshot.scopes].filter(
    (scope) =>
      scope.workspaceId === owned.workspaceId &&
      (enterprise
        ? scope.tenantId === owned.tenantId &&
          scope.accountId === owned.accountId &&
          scope.platform === owned.platform
        : !scope.tenantId && !scope.accountId)
  )
  const unique = new Map<string, MemoryScope>()
  for (const scope of authorized) {
    const key = learningScopeKey(scope)
    if (!unique.has(key)) unique.set(key, scope)
  }
  return [...unique.values()]
}

type RequestKind = 'snapshot' | 'detail' | 'mutation'
export interface LearningRequestToken {
  epoch: number
  kind: RequestKind
  sequence: number
}

/** UI response ownership only; the main process and server still establish authority. */
export class LearningRequestGuard {
  private epoch = 0
  private scope = 'default'
  private sequences: Record<RequestKind, number> = { snapshot: 0, detail: 0, mutation: 0 }
  select(scope?: MemoryScope): boolean {
    const key = learningScopeKey(scope)
    if (key === this.scope) return false
    this.scope = key
    this.invalidateAll()
    return true
  }
  begin(kind: RequestKind): LearningRequestToken {
    return { epoch: this.epoch, kind, sequence: ++this.sequences[kind] }
  }
  accepts(token: LearningRequestToken): boolean {
    return token.epoch === this.epoch && token.sequence === this.sequences[token.kind]
  }
  invalidate(kind: RequestKind): void {
    this.sequences[kind]++
  }
  invalidateAll(): void {
    this.epoch++
  }
}
