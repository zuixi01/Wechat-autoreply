// Constrain provider output before local Zod and native pixel validation.
// A provider which cannot enforce this format uses the same strict local guards.
export type VisionSchema = Record<string, unknown>
const object = (properties: Record<string, VisionSchema>): VisionSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false
})
const boolean = { type: 'boolean' }
const string = (maxLength: number): VisionSchema => ({ type: 'string', maxLength })
const coordinates = (length: number): VisionSchema => ({
  type: 'array',
  minItems: length,
  maxItems: length,
  items: { type: 'number', minimum: 0, maximum: 1 }
})
const point = coordinates(2)
const area = coordinates(4)
export const SearchLocatorVisionSchema = object({ search: point, loggedIn: boolean })
export const SearchMatchesVisionSchema = object({
  matches: {
    type: 'array',
    maxItems: 50,
    items: object({ name: string(128), privateChat: boolean, point })
  },
  hasMore: boolean
})
export const NavigationVisionSchema = object({
  loggedIn: boolean,
  overlay: boolean,
  chatTab: point
})
export const ChatVisionSchema = object({
  contact: string(128),
  privateChat: boolean,
  inputText: string(4096),
  messages: {
    type: 'array',
    maxItems: 80,
    items: object({
      direction: { type: 'string', enum: ['inbound', 'outbound', 'system'] },
      text: string(4096)
    })
  },
  header: area,
  history: area,
  input: area
})
export const ListVisionSchema = object({
  loggedIn: boolean,
  completeRows: boolean,
  currentContact: string(128),
  inputText: string(4096),
  list: area,
  input: area,
  rows: {
    type: 'array',
    maxItems: 100,
    items: object({
      name: { ...string(128), minLength: 1 },
      nameComplete: boolean,
      preview: string(4096),
      unread: { type: ['integer', 'null'], minimum: 0, maximum: 9999 },
      unreadDot: boolean,
      point,
      badge: { anyOf: [area, { type: 'null' }] }
    })
  },
  atTop: boolean,
  atBottom: boolean
})
