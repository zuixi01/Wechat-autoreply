import { describe, expect, it } from 'vitest'
import { assertLegacyChannel } from '../../src/preload/legacy-channels'

describe('legacy preload boundary', () => {
  it('excludes private device, runtime and hypothetical future routes from the generic bridge', () => {
    for (const operation of ['invoke', 'on', 'send'] as const)
      for (const channel of [
        'agent:register',
        'agent:status',
        'agent-runtime:start',
        'agent-runtime:pause',
        'agent:credential',
        'agent-workbench:reconcile',
        'executions:dispatch',
        'capture-screen',
        'test:vlm-parallel'
      ])
        expect(() => assertLegacyChannel(operation, channel)).toThrow('ipc_channel_unavailable')
  })
  it('does not allow reading or sending an event as an arbitrary invoke', () => {
    expect(() => assertLegacyChannel('invoke', 'settings:changed')).toThrow()
    expect(() => assertLegacyChannel('send', 'settings:set')).toThrow()
    expect(() => assertLegacyChannel('on', 'model:create')).toThrow()
    expect(() => assertLegacyChannel('invoke', 'model:list')).not.toThrow()
    expect(() => assertLegacyChannel('on', 'engine:recommendReply')).not.toThrow()
  })
  it('allows only the existing bounded wizard request pattern for dynamic send routes', () => {
    expect(() =>
      assertLegacyChannel('send', 'overlay-wizard:request-init:wizard-1790832366000-1')
    ).not.toThrow()
    for (const channel of [
      'overlay-wizard:request-init:agent:register',
      'overlay-wizard:request-init:../secrets',
      'overlay-wizard:request-init:wizard-1790832366000-1:agent:register',
      'overlay-wizard:request-init:wizard-1790832366000-0'
    ])
      expect(() => assertLegacyChannel('send', channel)).toThrow()
  })
})
