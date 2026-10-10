import { describe, expect, it } from 'vitest'
import {
  formatWechatReply,
  hasReplyIdentityLeak,
  ownerStyleExamples
} from '../../src/shared/reply-persona'

describe('account owner reply identity boundary', () => {
  it('keeps several sentences and emoji without a forced final full stop', () => {
    expect(formatWechatReply('先把文件发来。\n我看完告诉你😄。')).toBe(
      '先把文件发来。 我看完告诉你😄'
    )
    expect(formatWechatReply('收到。')).toBe('收到')
    expect(formatWechatReply('你想先处理哪一项？')).toBe('你想先处理哪一项？')
    expect(formatWechatReply('地址是 https://example.com/a.')).toBe('地址是 https://example.com/a.')
  })
  it('rejects malformed emoji noncharacters instead of sending invisible or garbled suffixes', () => {
    expect(() => formatWechatReply('晚安' + String.fromCodePoint(0x5ffff))).toThrow(
      'model_response_invalid'
    )
    expect(() => formatWechatReply('晚安\ud800')).toThrow('model_response_invalid')
    expect(() => formatWechatReply('。')).toThrow('model_response_invalid')
    expect(formatWechatReply('好嘞👨‍💻')).toBe('好嘞👨‍💻')
  })
  it('uses owner wording but excludes incoming, generated and identity-template messages', () => {
    expect(
      ownerStyleExamples(
        [
          { direction: 'inbound', text: '对方的口头习惯' },
          { direction: 'outbound', text: '你好呀～' },
          { direction: 'outbound', text: '哈哈，那就好😊' },
          { direction: 'outbound', text: '我是这个微信账号的本人呀' },
          { direction: 'outbound', text: '我是一个虚拟助手' },
          { direction: 'outbound', text: '好嘞，等我一下哈' },
          { direction: 'outbound', text: '好嘞，等我一下哈' },
          { direction: 'outbound', text: '成，晚点聊' }
        ],
        ['你好呀~', '哈哈，那就好😁']
      )
    ).toEqual(['好嘞，等我一下哈', '成，晚点聊'])
  })
  it.each([
    '我是这个微信账号的本人呀，平时会聊天。',
    '我负责代写微信账号本人的回复。',
    '我没有现实中的身体，今天没法真的出去运动呀。',
    '我没有真实的所在地呀，不过可以陪你聊聊天。',
    '我是一个虚拟助手。',
    '作为一个 AI，我不能替你出去玩。',
    '我是人工智能，没有情感。',
    '我只是一个语言模型。',
    '我不是真实的人。',
    '没有物理的身体，没法出门。',
    '我只存在在网络里。',
    'I am an AI assistant.',
    "I'm just a virtual assistant.",
    "I don't have a physical body.",
    '我\u200B是一个ＡＩ助手。'
  ])('blocks a nonhuman self-description: %s', (reply) => {
    expect(hasReplyIdentityLeak(reply)).toBe(true)
  })

  it.each([
    '这种天气出去走走正好。',
    '想去哪儿打？',
    '我没有身体不舒服，别担心。',
    '我在研究 AI 绘画，挺有意思的。',
    '我是 AI 工程师，平时做开发。',
    '我是人工智能专业的学生。',
    '这个游戏的虚拟角色做得不错。',
    '这会儿有自动回复工具帮忙接消息，我看到会回你。',
    '今天去不了，下次再约。'
  ])('preserves normal chat, factual limits and honest tool disclosure: %s', (reply) => {
    expect(hasReplyIdentityLeak(reply)).toBe(false)
  })
})
