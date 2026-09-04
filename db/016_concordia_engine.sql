ALTER TABLE projects ADD COLUMN IF NOT EXISTS simulation_engine TEXT NOT NULL DEFAULT 'concordia';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS simulation_engine_version TEXT NOT NULL DEFAULT '2.4.0';

ALTER TABLE characters ALTER COLUMN thread_contract_version SET DEFAULT 3;
ALTER TABLE projects ALTER COLUMN director_thread_contract_version SET DEFAULT 3;

UPDATE characters
SET thread_rollover_required=TRUE
WHERE active_thread_id IS NOT NULL AND thread_contract_version < 3;

UPDATE characters
SET thread_contract_version=3
WHERE active_thread_id IS NULL AND thread_contract_version < 3;

UPDATE projects
SET director_thread_rollover_required=TRUE
WHERE active_director_thread_id IS NOT NULL AND director_thread_contract_version < 3;

UPDATE projects
SET director_thread_contract_version=3
WHERE active_director_thread_id IS NULL AND director_thread_contract_version < 3;

UPDATE projects
SET simulation_engine='concordia',simulation_engine_version='2.4.0';
