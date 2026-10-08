import { z } from 'zod'

export const NativePackageSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    adapterVersion: z.enum(['0.2.0', '0.3.0', '0.4.0']),
    protocolVersion: z.literal(1),
    runtime: z.literal('win-x64'),
    deployment: z.literal('self-contained'),
    entrypoint: z.literal('WindowsAdapter.exe'),
    files: z
      .array(
        z.strictObject({
          path: z
            .string()
            .min(1)
            .max(240)
            .refine((path) =>
              path
                .split('/')
                .every(
                  (part) => /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(part) && !part.endsWith('.')
                )
            ),
          bytes: z.number().int().nonnegative().max(100_000_000),
          sha256: z.string().regex(/^[a-f0-9]{64}$/)
        })
      )
      .min(1)
      .max(1024)
  })
  .superRefine((value, ctx) => {
    const names = value.files.map((file) => file.path.toLowerCase())
    if (
      new Set(names).size !== names.length ||
      names.includes('native-manifest.json') ||
      value.files.reduce((sum, file) => sum + file.bytes, 0) > 500_000_000
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid native package inventory' })
    for (const name of [
      'WindowsAdapter.exe',
      'WindowsAdapter.dll',
      'WindowsAdapter.deps.json',
      'WindowsAdapter.runtimeconfig.json',
      'coreclr.dll',
      'hostfxr.dll',
      'hostpolicy.dll',
      'System.Private.CoreLib.dll',
      'UIAutomationClient.dll',
      'UIAutomationTypes.dll'
    ])
      if (!value.files.some((file) => file.path === name))
        ctx.addIssue({ code: 'custom', message: 'Native package is incomplete' })
  })
export type NativePackage = z.infer<typeof NativePackageSchema>

export const NativeRuntimeConfigSchema = z
  .object({
    runtimeOptions: z.object({
      tfm: z.literal('net10.0'),
      framework: z.never().optional(),
      frameworks: z.never().optional(),
      includedFrameworks: z
        .array(
          z.object({
            name: z.enum(['Microsoft.NETCore.App', 'Microsoft.WindowsDesktop.App']),
            version: z.string().regex(/^10\.0\.\d+$/)
          })
        )
        .length(2)
    })
  })
  .refine((value) => new Set(value.runtimeOptions.includedFrameworks.map((f) => f.name)).size === 2)

const LegacyNativeAdapterInfoSchema = z.strictObject({
  adapterVersion: z.literal('0.2.0'),
  commands: z.tuple([z.literal('info'), z.literal('listWindows'), z.literal('probe')]),
  backgroundReadVerified: z.literal(false),
  nonInterferingSendVerified: z.literal(false),
  identityVerified: z.literal(false)
})
export const NativeAdapterInfoSchema = z.discriminatedUnion('adapterVersion', [
  LegacyNativeAdapterInfoSchema,
  LegacyNativeAdapterInfoSchema.extend({
    adapterVersion: z.literal('0.3.0'),
    probeViews: z.tuple([z.literal('control'), z.literal('raw')])
  }),
  LegacyNativeAdapterInfoSchema.extend({
    adapterVersion: z.literal('0.4.0'),
    probeViews: z.tuple([z.literal('control'), z.literal('raw')]),
    desktopActivityObservation: z.literal(true)
  })
])
