import { ConversationBindingSchema, type ConversationBinding } from '../../shared/contracts/identity'
import { MemoryScopeSchema, type MemoryScope } from '../../shared/contracts/learning-memory'

/** A screen name or model claim is never sufficient to bind personal learning. */
export function resolveLearningScope(workspaceId: string, binding: ConversationBinding | null): MemoryScope | null {
  const verified = ConversationBindingSchema.safeParse(binding)
  if (!verified.success || !verified.data.identityVerified) return null
  const { identity, conversationId } = verified.data
  const scope = MemoryScopeSchema.safeParse({ workspaceId, platform: identity.platform,
    tenantId: identity.tenantId, accountId: identity.accountId, conversationId })
  return scope.success ? scope.data : null
}
