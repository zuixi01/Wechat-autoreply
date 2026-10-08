import { z } from 'zod'
import { DesktopActivitySchema } from './desktop-activity'

export const NativeWindowBindingSchema = z.strictObject({
  handle: z
    .string()
    .regex(/^[1-9]\d*$/)
    .max(19)
    .refine((v) => v.length <= 19 && /^[1-9]\d*$/.test(v) && BigInt(v) <= 9223372036854775807n),
  processId: z.number().int().positive().max(2147483647),
  processName: z.enum(['Weixin', 'WeChat', 'WXWork']),
  processStartTicks: z
    .string()
    .regex(/^[1-9]\d*$/)
    .max(19)
    .refine((v) => v.length <= 19 && /^[1-9]\d*$/.test(v) && BigInt(v) <= 9223372036854775807n)
})
const Node = z.strictObject({
  index: z.number().int().min(0).max(299),
  parentIndex: z.number().int().min(0).max(298).nullable(),
  depth: z.number().int().min(0).max(8),
  runtimeId: z.array(z.number().int().min(-2147483648).max(2147483647)).min(1).max(64).nullable(),
  controlType: z
    .string()
    .regex(/^ControlType\.[A-Za-z]+$/)
    .max(128),
  className: z.string().max(256),
  automationId: z.string().max(256),
  offscreen: z.boolean(),
  enabled: z.boolean(),
  patterns: z
    .array(
      z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9.]*$/)
        .max(128)
    )
    .max(32)
})
const LegacyNativeProbeSchema = z.strictObject({
  formatVersion: z.literal(1),
  adapterVersion: z.literal('0.2.0'),
  snapshotId: z.string().uuid(),
  binding: NativeWindowBindingSchema,
  capturedAt: z.number().int().nonnegative().safe(),
  clientFileVersion: z.string().min(1).max(128).nullable(),
  windowsVersion: z.string().min(1).max(128),
  nodes: z.array(Node).max(300),
  incompleteReasons: z
    .array(
      z.enum([
        'node_limit',
        'depth_limit',
        'time_limit',
        'element_unavailable',
        'runtime_id_unavailable',
        'metadata_truncated',
        'metadata_unavailable',
        'version_unavailable',
        'foreign_process_element'
      ])
    )
    .max(9),
  truncated: z.boolean(),
  elapsedMs: z.number().int().min(0).max(10000),
  foregroundBeforeHandle: z
    .string()
    .regex(/^-?\d+$/)
    .max(20),
  foregroundAfterHandle: z
    .string()
    .regex(/^-?\d+$/)
    .max(20),
  foregroundChangedAtEnd: z.boolean(),
  backgroundReadVerified: z.literal(false),
  nonInterferingSendVerified: z.literal(false),
  identityVerified: z.literal(false),
  conclusion: z.literal('metadata_only_requires_platform_validation')
})
export const NativeTreeViewSchema = z.enum(['control', 'raw'])
const RawNativeProbeSchema = LegacyNativeProbeSchema.extend({
  formatVersion: z.literal(2),
  adapterVersion: z.literal('0.3.0'),
  treeView: NativeTreeViewSchema,
  nodes: z
    .array(Node.extend({ isControlElement: z.boolean(), isContentElement: z.boolean() }))
    .max(300)
})
export const NativeProbeSchema = z
  .discriminatedUnion('formatVersion', [
    LegacyNativeProbeSchema,
    RawNativeProbeSchema,
    RawNativeProbeSchema.extend({
      formatVersion: z.literal(3),
      adapterVersion: z.literal('0.4.0'),
      desktopActivity: DesktopActivitySchema,
      incompleteReasons: z
        .array(
          LegacyNativeProbeSchema.shape.incompleteReasons.element.or(
            z.literal('activity_unavailable')
          )
        )
        .max(10)
    })
  ])
  .superRefine((value, ctx) => {
    const invalid = (): void =>
      ctx.addIssue({ code: 'custom', message: 'Inconsistent native probe evidence' })
    if (
      value.formatVersion === 3 &&
      (value.incompleteReasons.includes('activity_unavailable') !==
        !value.desktopActivity.complete ||
        value.desktopActivity.observedForMs > value.elapsedMs)
    )
      invalid()
    if (
      value.truncated !== value.incompleteReasons.length > 0 ||
      new Set(value.incompleteReasons).size !== value.incompleteReasons.length ||
      (!value.nodes.length && !value.truncated) ||
      (!value.clientFileVersion && !value.incompleteReasons.includes('version_unavailable')) ||
      (value.elapsedMs > 3000 && !value.incompleteReasons.includes('time_limit')) ||
      value.foregroundChangedAtEnd !==
        (value.foregroundBeforeHandle !== value.foregroundAfterHandle)
    )
      invalid()
    value.nodes.forEach((node, index) => {
      if (
        node.index !== index ||
        new Set(node.patterns).size !== node.patterns.length ||
        (index === 0
          ? node.parentIndex !== null || node.depth !== 0
          : node.parentIndex === null ||
            node.parentIndex >= index ||
            value.nodes[node.parentIndex].depth + 1 !== node.depth) ||
        (node.runtimeId === null && !value.incompleteReasons.includes('runtime_id_unavailable'))
      )
        invalid()
    })
  })
export type NativeProbe = z.infer<typeof NativeProbeSchema>
