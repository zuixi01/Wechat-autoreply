import type { DatabaseSync } from 'node:sqlite'
import { knowledgeTerms } from '../knowledge/retrieval'
import { memorySearchText } from './learning-retrieval'
import type { MemoryRevision } from '../../shared/contracts/learning-memory'
import { episodeSearchText } from './learning-episodes'
import type { LearningEpisode } from '../../shared/contracts/learning-memory'

export function initializeLearningDatabase(db: DatabaseSync): void {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
  if (version > 16) throw new Error('unsupported_learning_database_version')
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS learning_episodes (
      id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, scope_json TEXT NOT NULL,
      source_id TEXT NOT NULL, input_hash TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(scope_key,source_id)
    );
    CREATE TABLE IF NOT EXISTS learning_memories (
      id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, scope_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','active','stale','archived')),
      current_revision INTEGER NOT NULL, active_revision INTEGER,
      pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS learning_memories_scope ON learning_memories(scope_key,state);
    CREATE TABLE IF NOT EXISTS learning_revisions (
      memory_id TEXT NOT NULL REFERENCES learning_memories(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, content_hash TEXT NOT NULL, payload TEXT NOT NULL,
      activated_at INTEGER, PRIMARY KEY(memory_id,revision)
    );
    CREATE TABLE IF NOT EXISTS learning_feedback (
      scope_key TEXT NOT NULL, source_id TEXT NOT NULL, input_hash TEXT NOT NULL,
      episode_id TEXT NOT NULL REFERENCES learning_episodes(id) ON DELETE CASCADE, payload TEXT NOT NULL,
      PRIMARY KEY(scope_key,source_id)
    );
    CREATE TABLE IF NOT EXISTS learning_tombstones (
      scope_key TEXT NOT NULL, kind TEXT NOT NULL, fingerprint TEXT NOT NULL, forgotten_at INTEGER NOT NULL,
      PRIMARY KEY(scope_key,kind,fingerprint)
    );
    CREATE TABLE IF NOT EXISTS learning_mutations (
      id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, memory_id TEXT NOT NULL,
      action TEXT NOT NULL, revision INTEGER NOT NULL, at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_settings (scope_key TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS learning_settings_audit (
      id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,before_hash TEXT NOT NULL,after_hash TEXT NOT NULL,
      payload TEXT NOT NULL,at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS learning_settings_audit_scope ON learning_settings_audit(scope_key,at);
    CREATE TABLE IF NOT EXISTS learning_validation_environment (scope_key TEXT PRIMARY KEY,payload TEXT NOT NULL,epoch INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS learning_calibration_sets (
      scope_key TEXT PRIMARY KEY,scope_json TEXT NOT NULL,payload TEXT NOT NULL,input_hash TEXT NOT NULL,imported_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_curation_state (
      scope_key TEXT PRIMARY KEY,scope_json TEXT NOT NULL,observed_at INTEGER,last_run_at INTEGER,last_activity_at INTEGER NOT NULL,epoch INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_curation_reports (
      id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_memory_replacements (
      scope_key TEXT NOT NULL,proposed_id TEXT NOT NULL REFERENCES learning_memories(id) ON DELETE CASCADE,
      superseded_id TEXT NOT NULL REFERENCES learning_memories(id) ON DELETE CASCADE,superseded_revision INTEGER NOT NULL,
      applied_at INTEGER,PRIMARY KEY(proposed_id,superseded_id)
    );
    CREATE TABLE IF NOT EXISTS learning_activation_grants (
      id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,memory_id TEXT NOT NULL REFERENCES learning_memories(id) ON DELETE CASCADE,payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_revision_quarantines (
      scope_key TEXT NOT NULL,memory_id TEXT NOT NULL REFERENCES learning_memories(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,feedback_source_id TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(scope_key,memory_id,revision)
    );
    CREATE TABLE IF NOT EXISTS learning_validation_reports (
      id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,memory_id TEXT NOT NULL REFERENCES learning_memories(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_validation_runs (
      id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,scope_json TEXT NOT NULL,source_id TEXT NOT NULL,
      state TEXT NOT NULL,lease_until INTEGER NOT NULL,token TEXT NOT NULL,UNIQUE(scope_key,source_id)
    );
    CREATE TABLE IF NOT EXISTS learning_validation_attempts (
      id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES learning_validation_runs(id) ON DELETE CASCADE,
      scope_key TEXT NOT NULL,source_id TEXT NOT NULL,budget_key TEXT NOT NULL,day TEXT NOT NULL,
      charged_tokens INTEGER NOT NULL,state TEXT NOT NULL,measurement TEXT NOT NULL,
      input_limit INTEGER NOT NULL,output_limit INTEGER NOT NULL,input_tokens INTEGER,output_tokens INTEGER,
      UNIQUE(run_id,source_id)
    );
    CREATE TABLE IF NOT EXISTS learning_problems (
      id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,scope_json TEXT NOT NULL,problem_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,last_activity_at INTEGER NOT NULL,closed_episode_id TEXT,
      UNIQUE(scope_key,problem_id)
    );
    CREATE INDEX IF NOT EXISTS learning_problems_idle ON learning_problems(last_activity_at)
      WHERE closed_episode_id IS NULL;
    CREATE TABLE IF NOT EXISTS learning_problem_events (
      scope_key TEXT NOT NULL,source_id TEXT NOT NULL,problem_id TEXT NOT NULL REFERENCES learning_problems(id) ON DELETE CASCADE,
      input_hash TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT,
      PRIMARY KEY(scope_key,source_id)
    );
    CREATE TABLE IF NOT EXISTS learning_generations (
      scope_key TEXT NOT NULL,generation_id TEXT NOT NULL,episode_id TEXT NOT NULL REFERENCES learning_episodes(id) ON DELETE CASCADE,
      problem_id TEXT NOT NULL,refs_json TEXT NOT NULL,PRIMARY KEY(scope_key,generation_id),UNIQUE(scope_key,episode_id)
    );
    CREATE INDEX IF NOT EXISTS learning_episodes_scope_created ON learning_episodes(scope_key,created_at);
    CREATE TABLE IF NOT EXISTS learning_redacted_evidence (
      scope_key TEXT NOT NULL,episode_id TEXT NOT NULL,redacted_at INTEGER NOT NULL,
      PRIMARY KEY(scope_key,episode_id)
    );
    CREATE TABLE IF NOT EXISTS learning_corpus (scope_key TEXT PRIMARY KEY,version INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS learning_corpus_update AFTER UPDATE ON learning_memories
      WHEN (old.active_revision IS NOT new.active_revision OR old.state!=new.state)
        AND (old.state IN ('active','stale') OR new.state IN ('active','stale'))
      BEGIN INSERT INTO learning_corpus VALUES(new.scope_key,1)
        ON CONFLICT(scope_key) DO UPDATE SET version=version+1; END;
    CREATE TRIGGER IF NOT EXISTS learning_corpus_delete AFTER DELETE ON learning_memories
      WHEN old.state IN ('active','stale')
      BEGIN INSERT INTO learning_corpus VALUES(old.scope_key,1)
        ON CONFLICT(scope_key) DO UPDATE SET version=version+1; END;
    CREATE TABLE IF NOT EXISTS learning_legacy (
      source_key TEXT PRIMARY KEY, source_hash TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_legacy_assignments (
      legacy_id TEXT PRIMARY KEY,source_key TEXT NOT NULL UNIQUE REFERENCES learning_legacy(source_key),
      scope_key TEXT NOT NULL,memory_id TEXT NOT NULL,episode_id TEXT NOT NULL,assigned_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS learning_search USING fts5(memory_id UNINDEXED, revision UNINDEXED, terms);
    CREATE VIRTUAL TABLE IF NOT EXISTS learning_episode_search USING fts5(episode_id UNINDEXED,terms);
    CREATE TRIGGER IF NOT EXISTS learning_episode_search_forget AFTER DELETE ON learning_episodes
      BEGIN DELETE FROM learning_episode_search WHERE episode_id=old.id; END;
    CREATE TRIGGER IF NOT EXISTS learning_search_forget AFTER DELETE ON learning_memories
      BEGIN DELETE FROM learning_search WHERE memory_id=old.id; END;
    CREATE TABLE IF NOT EXISTS learning_jobs (
      id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,state TEXT NOT NULL,available_at INTEGER NOT NULL,
      lease_until INTEGER,payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS learning_jobs_ready ON learning_jobs(state,available_at);
    CREATE TABLE IF NOT EXISTS learning_job_events (
      scope_key TEXT NOT NULL,source_id TEXT NOT NULL,input_hash TEXT NOT NULL,
      job_id TEXT NOT NULL REFERENCES learning_jobs(id) ON DELETE CASCADE,PRIMARY KEY(scope_key,source_id)
    );
    CREATE TABLE IF NOT EXISTS learning_review_attempts (
      claim_token TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES learning_jobs(id) ON DELETE CASCADE,
      budget_key TEXT NOT NULL,day TEXT NOT NULL,charged_tokens INTEGER NOT NULL,state TEXT NOT NULL,
      input_tokens INTEGER,output_tokens INTEGER,failure_code TEXT
    );
    CREATE TABLE IF NOT EXISTS learning_retained_usage (
      budget_key TEXT NOT NULL,day TEXT NOT NULL,charged_tokens INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,requests INTEGER NOT NULL,
      estimated_requests INTEGER NOT NULL,reported_requests INTEGER NOT NULL,PRIMARY KEY(budget_key,day)
    );
  `)
  try {
    if (
      !db
        .prepare('PRAGMA table_info(learning_review_attempts)')
        .all()
        .some((row) => row.name === 'measurement')
    )
      db.exec(
        "ALTER TABLE learning_review_attempts ADD COLUMN measurement TEXT NOT NULL DEFAULT 'unknown'"
      )
    if (
      !db
        .prepare('PRAGMA table_info(learning_review_attempts)')
        .all()
        .some((row) => row.name === 'reserved_tokens')
    ) {
      db.exec(
        'ALTER TABLE learning_review_attempts ADD COLUMN reserved_tokens INTEGER NOT NULL DEFAULT 0'
      )
      db.exec('UPDATE learning_review_attempts SET reserved_tokens=charged_tokens')
    }
    if (version < 2) {
      db.exec('DELETE FROM learning_search')
      for (const row of db
        .prepare('SELECT memory_id,revision,payload FROM learning_revisions')
        .all()) {
        const entry = JSON.parse(String(row.payload)) as MemoryRevision
        db.prepare('INSERT INTO learning_search VALUES(?,?,?)').run(
          String(row.memory_id),
          Number(row.revision),
          knowledgeTerms(memorySearchText(entry.content)).join(' ')
        )
      }
    }
    if (version < 5) {
      db.exec('DELETE FROM learning_episode_search')
      for (const row of db.prepare('SELECT id,payload FROM learning_episodes').all()) {
        const episode = JSON.parse(String(row.payload)) as LearningEpisode
        db.prepare('INSERT INTO learning_episode_search VALUES(?,?)').run(
          String(row.id),
          knowledgeTerms(episodeSearchText(episode)).join(' ')
        )
      }
    }
    if (
      !db
        .prepare('PRAGMA table_info(learning_memory_replacements)')
        .all()
        .some((column) => column.name === 'applied_at')
    )
      db.exec('ALTER TABLE learning_memory_replacements ADD COLUMN applied_at INTEGER')
    db.exec('PRAGMA user_version=16; COMMIT;')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
