import { z } from 'zod'

const Json = z.json()
const Content = z.union([z.string(), z.record(z.string(), Json), z.array(Json)])
const Explanation = Content.nullable().optional()
const Probability = z.number().min(0).max(1)
const Distribution = z.record(z.string().min(1), Probability).refine((probabilities) => {
  const values = Object.values(probabilities)
  return values.length > 0 && Math.abs(values.reduce((a, b) => a + b, 0) - 1) <= 0.02
}, 'Invalid probability distribution')

export const QuestionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('choice'),
    instructions: Explanation,
    criteria: z
      .record(z.string().min(1), Content.nullable())
      .refine((value) => Object.keys(value).length > 0)
  }),
  z.strictObject({
    type: z.literal('noul'),
    instructions: Explanation,
    criteria: z.object({ true: Explanation, false: Explanation }).nullable().optional()
  }),
  z.strictObject({
    type: z.literal('score'),
    instructions: Explanation,
    criteria: z.array(Content).min(1)
  })
])

export const JevRequestSchema = z.strictObject({
  model: z.string().min(1),
  state: z.union([z.string(), z.record(z.string(), Json), z.array(Json)]),
  questions: z
    .record(z.string().min(1), QuestionSchema)
    .refine((value) => Object.keys(value).length > 0)
})

export const AnswerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    choice: z.string().min(1),
    confidence: Probability,
    probabilities: Distribution
  }),
  z.object({ type: z.literal('noul'), noul: Probability }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    confidence: Probability,
    legend: z.record(z.string(), Content),
    probabilities: Distribution
  })
])
export const JevResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string().min(1), AnswerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative()
  })
})
export const ModelListSchema = z.object({
  models: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string(),
      release_date: z.string()
    })
  )
})
export type JevRequest = z.infer<typeof JevRequestSchema>
export type JevResponse = z.infer<typeof JevResponseSchema>
export type JevAnswer = z.infer<typeof AnswerSchema>
export interface DecisionProvider {
  evaluate(
    request: JevRequest,
    options?: { signal?: AbortSignal; deadlineMs?: number }
  ): Promise<JevResponse>
}

function sameKeys(a: object, b: object): boolean {
  const left = Object.keys(a).sort()
  const right = Object.keys(b).sort()
  return left.length === right.length && left.every((key, i) => key === right[i])
}

/** JSON object field order is not meaning; array element order remains meaningful. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameJson(item, b[i]))
    )
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>
  return (
    sameKeys(left, right) &&
    Object.keys(left).every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
  )
}

/** Validate the response against this request, not just against a generic JSON schema. */
export function parseJevResponse(request: JevRequest, data: unknown): JevResponse {
  const response = JevResponseSchema.parse(data)
  if (!sameKeys(request.questions, response.answers))
    throw new Error('Question answers do not match')
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = response.answers[id]
    if (answer.type !== question.type) throw new Error('Question answer type mismatch')
    if (answer.type === 'choice' && question.type === 'choice') {
      if (
        !sameKeys(question.criteria, answer.probabilities) ||
        !Object.hasOwn(question.criteria, answer.choice)
      ) {
        throw new Error('Unknown choice or incomplete distribution')
      }
      if (
        answer.probabilities[answer.choice] + 0.000001 <
        Math.max(...Object.values(answer.probabilities))
      ) {
        throw new Error('Selected choice is not the highest probability')
      }
    }
    if (answer.type === 'score' && question.type === 'score') {
      const levels = Object.fromEntries(question.criteria.map((value, i) => [String(i), value]))
      if (!sameKeys(levels, answer.legend) || !sameKeys(levels, answer.probabilities)) {
        throw new Error('Score rubric does not match')
      }
      for (const [key, level] of Object.entries(levels)) {
        if (!sameJson(level, answer.legend[key])) throw new Error('Score legend changed')
      }
      const expected = Object.entries(answer.probabilities).reduce(
        (total, [level, p]) => total + Number(level) * p,
        0
      )
      if (
        answer.score < 0 ||
        answer.score > question.criteria.length - 1 ||
        Math.abs(answer.score - expected) > 0.025
      ) {
        throw new Error('Invalid expected score')
      }
    }
  }
  return response
}
