SET search_path=autoreply,public;
-- Evaluation uses the existing account lease and fee ledger, but cannot be mistaken for
-- method calibration or curation. No new activation, publication or execution privilege.
ALTER TABLE learning_validation_runs DROP CONSTRAINT IF EXISTS learning_validation_runs_purpose_check;
ALTER TABLE learning_validation_runs ADD CONSTRAINT learning_validation_runs_purpose_check
  CHECK(purpose IN ('validation','curation','evaluation'));
ALTER TABLE learning_attempts DROP CONSTRAINT IF EXISTS learning_attempts_purpose_check;
ALTER TABLE learning_attempts ADD CONSTRAINT learning_attempts_purpose_check
  CHECK(purpose IN ('review','validation','curation','evaluation'));
