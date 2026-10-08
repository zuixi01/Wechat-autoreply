import { describe, expect, it } from 'vitest'
import {
  postgresArchiveArguments,
  postgresArchiveVersion,
  postgresRestoreArguments,
  validatePostgresArchiveList
} from '../../src/core/persistence/postgres-archive'

describe('fixed complete central archive commands', () => {
  it('imports only a generated fresh target with one atomic restore and no source ACL/owner authority', () => {
    const target = 'autoreply_restore_' + 'a'.repeat(32)
    expect(postgresRestoreArguments(target, 'literal archive.dump')).toEqual([
      '--single-transaction',
      '--exit-on-error',
      '--no-owner',
      '--no-privileges',
      '--no-password',
      '--dbname',
      target,
      'literal archive.dump'
    ])
    expect(() => postgresRestoreArguments('existing_business_db', 'literal archive.dump')).toThrow(
      'postgres_restore_target_invalid'
    )
  })
  it('accepts official version output including distribution build labels but stores only the version', () => {
    expect(postgresArchiveVersion('pg_dump (PostgreSQL) 16.15 (Debian 16.15-1.pgdg13+1)')).toBe(
      'pg_dump (PostgreSQL) 16.15'
    )
    expect(() => postgresArchiveVersion('pg_dump (PostgreSQL) 17.1')).toThrow(
      'postgres_archive_version_unsupported'
    )
  })
  it('exports full custom data without a table filter, partial RLS export, shell or credentials', () => {
    expect(postgresArchiveArguments()).toEqual([
      '--format=custom',
      '--no-password',
      '--lock-wait-timeout=5s'
    ])
    expect(postgresArchiveArguments().join(' ')).not.toMatch(
      /row-security|schema|table|data-only|password=/
    )
  })
  it('requires schema and table data for authority, publication, learning and restore history', () => {
    const tables = [
      'accounts',
      'agents',
      'execution_permits',
      'audit_events',
      'generation_publications',
      'learning_memories',
      'ledger_restore_reviews'
    ]
    const complete = tables
      .flatMap((table, i) => [
        `${i + 1}; 1259 42 TABLE autoreply ${table} postgres`,
        `${i + 100}; 0 42 TABLE DATA autoreply ${table} postgres`
      ])
      .join('\n')
    expect(() => validatePostgresArchiveList(complete)).not.toThrow()
    expect(() =>
      validatePostgresArchiveList(
        complete.replace('TABLE DATA autoreply accounts', 'TABLE DATA other accounts')
      )
    ).toThrow('postgres_archive_invalid')
    expect(() => validatePostgresArchiveList('PGDMP')).toThrow('postgres_archive_invalid')
  })
})
