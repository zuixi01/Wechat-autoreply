import { describe, expect, it, vi } from 'vitest'
import { GenericChannelSession, createInitialSystemChannelState, type ModeHandler } from '../../src/core/generic-channel-session'
import type { ChannelContext, SessionEvent } from '../../src/core/session-types'
describe('published-memory check at the actual send boundary', () => {
  it('rejects a queued reply whose memory changed before it could be shown or sent', async () => {
    const send = vi.fn(), recommend = vi.fn(), queue: SessionEvent[] = []
    const device = { setAppType: vi.fn(), screenshot: async () => 'image', screenshotWithHeader: async () => 'image', sendMessage: send, setChatBaseline: async () => {} }
    const channel = new GenericChannelSession(device as never)
    const mode: ModeHandler = { modeId: 'mode', modeName: 'mode', prompt: '', autoReply: true, sentimentEnabled: false, unifiedPrefix: '', replyModelHasVision: true, userInput: '', objectRelation: '', objectTitle: '', onRecommendReply: recommend, onLog: vi.fn(), onStandbyChange: vi.fn(), onPendingChange: vi.fn() }
    channel.registerModeHandler(mode)
    const ctx: ChannelContext<ReturnType<typeof createInitialSystemChannelState>> = { appType: 'wechat', state: createInitialSystemChannelState(), host: {
      enqueue: event => queue.push(event), schedule: vi.fn(), log: vi.fn(), trace: vi.fn(), isRunning: () => true,
      stopSession: async () => {}, getAutoReply: () => true, setAutoReply: vi.fn(), recommendReply: recommend,
      identifyContact: async () => 'name', resolveMode: () => ({ ...mode }), isLearningReplyCurrent: () => false,
      runProvider: async function* () { yield { type: 'reply_text', content: 'old', memorySnapshot: { snapshotId: 'old', corpusVersion: 'old', scope: { workspaceId: 'profile', platform: 'wechat' }, items: [], estimatedTokens: 0 } } }
    } }
    await channel.onEvent({ type: 'observe_chat' }, ctx)
    await vi.waitFor(() => expect(queue.some(event => event.type === 'provider.reply_text')).toBe(true))
    const reply = queue.find(event => event.type === 'provider.reply_text')!
    await channel.onEvent(reply, ctx)
    expect(recommend).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
    expect(ctx.host.log).toHaveBeenCalledWith('error', expect.stringContaining('工作记忆已更新'))
  })
})
