import { afterEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  writeText: vi.fn(),
  events: [] as string[],
  robot: {
    getMousePos: () => ({ x: 1, y: 1 }),
    moveMouse: vi.fn(),
    mouseClick: vi.fn(),
    keyTap: vi.fn(),
    keyToggle: vi.fn()
  }
}))
// Every native operation is replaced: this test never moves the employee's mouse or clipboard.
vi.mock('electron', () => ({ clipboard: { writeText: fake.writeText } }))
vi.mock('../../src/core/rpa/util', () => ({
  delay: async () => {},
  randomDelayIn: async () => {},
  getRobot: () => fake.robot
}))
vi.mock('../../src/core/rpa/window-utils', () => ({ getWindowInfo: async () => null }))
vi.mock('../../src/core/rpa/vision-utils', () => ({ getInputAreaFromCache: () => null }))
import { sendReplyByCoordsAction } from '../../src/core/rpa/input-utils'

afterEach(() => {
  fake.events.length = 0
  vi.restoreAllMocks()
})
describe('asynchronous Electron clipboard migration', () => {
  it('waits for the clipboard write before the existing paste action', async () => {
    let release!: () => void
    fake.writeText.mockImplementation(
      () =>
        new Promise<void>((done) => {
          release = () => {
            fake.events.push('clipboard-ready')
            done()
          }
        })
    )
    fake.robot.keyTap.mockImplementation((key) => {
      fake.events.push(key)
    })
    const pending = sendReplyByCoordsAction(1, 1, '合成回复')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(fake.events).toEqual([])
    release()
    expect(await pending).toBe(true)
    expect(fake.events[0]).toBe('clipboard-ready')
    expect(fake.events[1]).toBe('v')
  })
  it('never pastes or sends when the clipboard write rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fake.robot.keyTap.mockImplementation((key) => {
      fake.events.push(key)
    })
    fake.writeText.mockRejectedValue(new Error('synthetic clipboard failure'))
    expect(await sendReplyByCoordsAction(1, 1, '合成回复')).toBe(false)
    expect(fake.events).toEqual([])
  })
})
