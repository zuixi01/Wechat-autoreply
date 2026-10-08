/** Compatibility routes for existing screens. Private device/runtime APIs use named bridges. */
const invokes = new Set([
  'features:advanced-enable',
  'settings:getAll',
  'settings:get',
  'settings:set',
  'settings:open',
  'model:list',
  'model:create',
  'model:update',
  'model:delete',
  'model:testConnection',
  'mode:list',
  'mode:create',
  'mode:update',
  'mode:delete',
  'mode:toggleEnabled',
  'mode:start',
  'mode:stop',
  'mode:setAutoReply',
  'object:create',
  'object:update',
  'object:delete',
  'engine:exitStandby',
  'engine:setUserInput',
  'engine:start',
  'engine:stop',
  'engine:status',
  'engine:updateConfig',
  'engine:testConnection',
  'provider:installFromUrl',
  'provider:getInstalled',
  'providerHub:getCatalog',
  'providerHub:update',
  'reply:paste',
  'reply:send',
  'memory:open',
  'memory:listCards',
  'memory:learnFromSession',
  'memory:addCard',
  'memory:deleteCard',
  'memory:setCardEnabled',
  'trace:listSessions',
  'trace:getSession',
  'trace:getScreenshot',
  'capture:openSetupWizard',
  'capture:getRegions',
  'capture:resetRegions'
])
const events = new Set([
  'settings:changed',
  'mode:changed',
  'mode:runningChanged',
  'engine:state',
  'engine:log',
  'engine:recommendReply',
  'engine:standbyChanged',
  'engine:pendingChanged',
  'trace:step',
  'capture:regions-updated',
  'overlay-wizard:init'
])
const sends = new Set(['mode:changed', 'overlay-wizard:complete', 'overlay-wizard:cancel'])

export function assertLegacyChannel(operation: 'invoke' | 'on' | 'send', channel: string): void {
  const allowed =
    operation === 'invoke'
      ? invokes.has(channel)
      : operation === 'on'
        ? events.has(channel)
        : sends.has(channel) ||
          /^overlay-wizard:request-init:wizard-\d{13}-[1-9]\d{0,9}$/.test(channel)
  if (!allowed) throw new Error('ipc_channel_unavailable')
}
