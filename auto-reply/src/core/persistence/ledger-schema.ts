export const CURRENT_LEDGER_SCHEMA = 13
export type LedgerSchemaVersion = 11 | 12 | 13
export function supportedLedgerSchema(version: unknown): version is LedgerSchemaVersion {
  return version === 11 || version === 12 || version === CURRENT_LEDGER_SCHEMA
}
