import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { expect, it } from 'vitest'
import { hashContext } from '../../src/core/reply/hashes'
import {
  RestoreHistoryProofVerifier,
  restoreHistorySigningBytes,
  type RestoreHistoryRequirement
} from '../../server/src/recovery/restore-history-proof'
import type { RestoreHistoryProof } from '../../src/shared/contracts/restore-history'
import { historyFixture } from '../fixtures/restore-history'

it('authenticates a complete source claim including additional conversations, without granting execution or claiming physical proof', () => {
  const f = historyFixture(),
    before = hashContext(f.required)
  const result = f.verifier().check(f.envelope(), f.required, f.now)
  expect(result).toMatchObject({
    conversations: 2,
    messages: 2,
    localMessageAnchors: 1,
    additionalMessages: 1,
    sourceClaimAuthenticated: true,
    structurallyComplete: true,
    physicalHistoryVerifiedByThisCheck: false,
    executionOutcomesVerified: false,
    canRelease: false
  })
  expect(result.proofHash).toBe(hashContext(f.proof))
  expect(result.signedProofHash).toBe(hashContext(f.envelope()))
  expect(result.sourceTrustHash).toBe(hashContext(f.trust))
  expect(JSON.stringify(result)).not.toContain('old-message')
  expect(hashContext(f.required)).toBe(before)
})
it('refuses unconfigured sources, false physical capability, invalid/duplicate keys and later config mutation', () => {
  const f = historyFixture()
  expect(() => new RestoreHistoryProofVerifier([]).check(f.envelope(), f.required, f.now)).toThrow(
    'restore_history_source_untrusted'
  )
  expect(
    () =>
      new RestoreHistoryProofVerifier([
        { ...f.trust, completeAccountHistoryVerified: false } as never
      ])
  ).toThrow('restore_history_source_untrusted')
  expect(() => new RestoreHistoryProofVerifier([{ ...f.trust, publicKeyPem: 'bad key' }])).toThrow(
    'restore_history_source_untrusted'
  )
  expect(() => new RestoreHistoryProofVerifier([f.trust, f.trust])).toThrow(
    'restore_history_source_untrusted'
  )
  const verifier = f.verifier()
  f.trust.notAfter = 0
  expect(verifier.check(f.envelope(), f.required, f.now).sourceClaimAuthenticated).toBe(true)
})
it.each(['version', 'releaseSha256', 'keyId'] as const)(
  'rejects a correctly signed report from an unpinned %s',
  (field) => {
    const f = historyFixture()
    // Proof and config do not share objects after the verifier captures its configuration.
    const verifier = f.verifier()
    f.proof.source = {
      ...f.proof.source,
      [field]: field === 'releaseSha256' ? '1'.repeat(64) : 'other'
    }
    expect(() => verifier.check(f.envelope(), f.required, f.now)).toThrow(
      'restore_history_source_untrusted'
    )
  }
)
it('rejects tampering, another private key, wrong signing domain and noncanonical signature encoding', () => {
  const f = historyFixture(),
    verifier = f.verifier(),
    saved = f.envelope()
  f.proof.conversations[0].messages[1].contentHash = '1'.repeat(64)
  expect(() => verifier.check(saved, f.required, f.now)).toThrow(
    'restore_history_signature_invalid'
  )
  const other = generateKeyPairSync('ed25519')
  expect(() =>
    verifier.check(
      {
        ...f.envelope(),
        signature: sign(null, restoreHistorySigningBytes(f.proof), other.privateKey).toString(
          'base64url'
        )
      },
      f.required,
      f.now
    )
  ).toThrow('restore_history_signature_invalid')
  expect(() =>
    verifier.check(
      {
        ...f.envelope(),
        signature: sign(null, Buffer.from(hashContext(f.proof)), f.keys.privateKey).toString(
          'base64url'
        )
      },
      f.required,
      f.now
    )
  ).toThrow('restore_history_signature_invalid')
  const signed = f.envelope(),
    alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  signed.signature =
    signed.signature.slice(0, -1) + alphabet[alphabet.indexOf(signed.signature.at(-1)!) + 1]
  expect(() => verifier.check(signed, f.required, f.now)).toThrow(
    'restore_history_signature_invalid'
  )
})
it.each(['caseId', 'uploadId', 'restoreId', 'contextHash', 'inventoryBasisHash'] as const)(
  'binds the exact %s and refuses cross-restoration replay',
  (field) => {
    const f = historyFixture()
    f.proof[field] = field.endsWith('Hash') ? '1'.repeat(64) : randomUUID()
    expect(() => f.verifier().check(f.envelope(), f.required, f.now)).toThrow(
      'restore_history_context_conflict'
    )
  }
)
it('binds the trusted platform account, tenant, account, employee, agent and platform', () => {
  for (const field of ['tenant_id', 'account_id', 'employee_id', 'agent_id', 'platform'] as const) {
    const f = historyFixture()
    f.proof.scope = { ...f.proof.scope, [field]: field === 'platform' ? 'wework' : 'foreign' }
    expect(() => f.verifier().check(f.envelope(), f.required, f.now)).toThrow(
      field === 'employee_id' || field === 'agent_id'
        ? 'restore_history_context_conflict'
        : 'restore_history_source_untrusted'
    )
  }
  const f = historyFixture()
  f.proof.platformAccountIdHash = '1'.repeat(64)
  expect(() => f.verifier().check(f.envelope(), f.required, f.now)).toThrow(
    'restore_history_source_untrusted'
  )
})
it('rejects every partial-account/partial-conversation flag and missing page', () => {
  const changes = [
    (p: RestoreHistoryProof) => {
      p.complete = false
    },
    (p: RestoreHistoryProof) => {
      p.allConversationsEnumerated = false
    },
    (p: RestoreHistoryProof) => {
      p.nextPageToken = 'next'
    },
    (p: RestoreHistoryProof) => {
      p.conversations[0].complete = false
    },
    (p: RestoreHistoryProof) => {
      p.conversations[0].hasGap = true
    },
    (p: RestoreHistoryProof) => {
      p.conversations[0].nextPageToken = 'next'
    }
  ]
  for (const change of changes) {
    const f = historyFixture()
    change(f.proof)
    expect(() => f.verifier().check(f.envelope(), f.required, f.now)).toThrow(
      'restore_history_incomplete'
    )
  }
})
it('rejects duplicated conversations/messages, discontinuous positions and messages after the observation boundary', () => {
  const changes = [
    (p: RestoreHistoryProof) => {
      p.conversations.push(structuredClone(p.conversations[0]))
    },
    (p: RestoreHistoryProof) => {
      p.conversations[0].messages[1].sourceMessageId = 'old-message'
    },
    (p: RestoreHistoryProof) => {
      p.conversations[0].messages[1].position = 3
    },
    (p: RestoreHistoryProof) => {
      p.conversations[0].messages[1].sentAt = p.observedThrough + 1
    }
  ]
  for (const change of changes) {
    const f = historyFixture()
    change(f.proof)
    expect(() => f.verifier().check(f.envelope(), f.required, f.now)).toThrow(
      'restore_history_incomplete'
    )
  }
})
it('rejects missing anchors and mismatched text hashes or directions even with a correct source signature', () => {
  const changes = [
    (p: RestoreHistoryProof) => {
      p.conversations = []
    },
    (p: RestoreHistoryProof) => {
      p.conversations[0].messages = []
    },
    (p: RestoreHistoryProof) => {
      p.conversations[0].messages[0].direction = 'automation_outbound'
    },
    (p: RestoreHistoryProof) => {
      p.conversations[0].messages[0].contentHash = '1'.repeat(64)
    }
  ]
  for (const change of changes) {
    const f = historyFixture()
    change(f.proof)
    expect(() => f.verifier().check(f.envelope(), f.required, f.now)).toThrow(
      'restore_history_anchor_conflict'
    )
  }
})
it('rejects gaps in coverage, premature/late captures, stale observations, expired and revoked sources', () => {
  const changes = [
    (p: RestoreHistoryProof) => {
      p.historyFrom = 1995001
    },
    (p: RestoreHistoryProof) => {
      p.observedThrough = 1997999
    },
    (p: RestoreHistoryProof) => {
      p.capturedAt = p.observedThrough - 1
    },
    (p: RestoreHistoryProof) => {
      p.capturedAt = 2000001
    }
  ]
  for (const change of changes) {
    const f = historyFixture()
    change(f.proof)
    expect(() => f.verifier().check(f.envelope(), f.required, f.now)).toThrow(
      'restore_history_time_invalid'
    )
  }
  const f = historyFixture()
  f.trust.notAfter = f.now + 1000000
  expect(() => f.verifier().check(f.envelope(), f.required, f.now + 300001)).toThrow(
    'restore_history_time_invalid'
  )
  f.trust.revokedAt = f.now
  expect(() => f.verifier().check(f.envelope(), f.required, f.now)).toThrow(
    'restore_history_source_untrusted'
  )
  f.trust.revokedAt = null
  f.trust.notAfter = f.now
  expect(() => f.verifier().check(f.envelope(), f.required, f.now)).toThrow(
    'restore_history_source_untrusted'
  )
})
it('verifies the entire restored inventory, not a display page or guessed message identity', () => {
  const changes = [
    (r: RestoreHistoryRequirement) => {
      r.items = []
    },
    (r: RestoreHistoryRequirement) => {
      r.manifest.summary.messages = 2
    },
    (r: RestoreHistoryRequirement) => {
      r.manifest.context.sourceSha256 = '1'.repeat(64)
    },
    (r: RestoreHistoryRequirement) => {
      r.items[0].identity.accountId = 'foreign'
    },
    (r: RestoreHistoryRequirement) => {
      r.items[0].key = 'm:' + '0'.repeat(64) + ':0000000000000001'
    },
    (r: RestoreHistoryRequirement) => {
      if (r.items[0].kind === 'message') r.items[0].messageIdVerified = false
    }
  ]
  for (const change of changes) {
    const f = historyFixture()
    change(f.required)
    expect(() => f.verifier().check(f.envelope(), f.required, f.now)).toThrow(
      'restore_history_inventory_invalid'
    )
  }
})
it('requires known execution-only conversations but never verifies an unknown execution outcome', () => {
  const f = historyFixture(),
    i = f.required.items[0].identity
  const executionId = randomUUID()
  f.required.items.push({
    kind: 'execution',
    key: `s:${executionId}`,
    identity: i,
    conversationId: 'execution-only-customer',
    executionId,
    taskId: 'synthetic-task',
    taskHash: '1'.repeat(64),
    draftHash: '2'.repeat(64),
    inboundRange: { from: 1, to: 1 },
    localRangePresent: false,
    status: 'unknown',
    phase: 'unresolved',
    permitId: null,
    requestHash: null,
    permitHash: null,
    permitStatus: null,
    centralUpdatedAt: null,
    conversation: null,
    controlHash: null,
    receiptStatus: null,
    receiptHash: null,
    evidenceHash: null,
    baselineSequence: null,
    createdAt: 1,
    updatedAt: 2
  })
  Object.assign(f.required.manifest.summary, {
    executions: 1,
    unknownExecutions: 1,
    pendingCentral: 1
  })
  f.rehash()
  f.proof.inventoryBasisHash = f.required.manifest.basisHash
  expect(() => f.verifier().check(f.envelope(), f.required, f.now)).toThrow(
    'restore_history_anchor_conflict'
  )
  f.proof.conversations.push({
    conversationId: 'execution-only-customer',
    complete: true,
    hasGap: false,
    nextPageToken: null,
    messages: []
  })
  expect(f.verifier().check(f.envelope(), f.required, f.now)).toMatchObject({
    executionOutcomesVerified: false,
    canRelease: false
  })
})
it('rejects whole-account overflow before parsing or accepting an attacker-supplied trust configuration', () => {
  const f = historyFixture(),
    signed = f.envelope()
  const message = f.proof.conversations[0].messages[0]
  f.proof.conversations[0].messages = Array(100001).fill(message)
  f.proof.conversations[1].messages = Array(100000).fill(message)
  expect(() => f.verifier().check(signed, f.required, f.now)).toThrow('restore_history_incomplete')
  const clean = historyFixture()
  expect(() =>
    clean.verifier().check({ ...clean.envelope(), trust: clean.trust }, clean.required, clean.now)
  ).toThrow('restore_history_invalid')
})

it('does not mistake an authenticated source that hides an unknown later message for empirical completeness', () => {
  const f = historyFixture()
  f.proof.conversations[0].messages.pop()
  const checked = f.verifier().check(f.envelope(), f.required, f.now)
  // The omitted post-backup message is unknown to the restored file. Cryptography cannot discover it.
  expect(checked).toMatchObject({
    sourceClaimAuthenticated: true,
    additionalMessages: 0,
    physicalHistoryVerifiedByThisCheck: false,
    executionOutcomesVerified: false,
    canRelease: false
  })
})

it('rejects an inventory anchor observed after the captured history boundary', () => {
  const f = historyFixture()
  if (f.required.items[0].kind === 'message') f.required.items[0].observedAt = f.now
  f.rehash()
  f.proof.inventoryBasisHash = f.required.manifest.basisHash
  expect(() => f.verifier().check(f.envelope(), f.required, f.now)).toThrow(
    'restore_history_time_invalid'
  )
})
