ALTER TABLE projects ADD COLUMN IF NOT EXISTS drama_intensity TEXT NOT NULL DEFAULT 'balanced';
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_drama_intensity_check;
ALTER TABLE projects ADD CONSTRAINT projects_drama_intensity_check CHECK (drama_intensity IN ('gentle','balanced','high'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS story_state JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE scenes ADD COLUMN IF NOT EXISTS dramatic_state JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE character_memories ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE character_memories ADD COLUMN IF NOT EXISTS normalized_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS character_memories_active_key_idx
ON character_memories(character_id,normalized_key) WHERE archived_at IS NULL AND normalized_key IS NOT NULL;

ALTER TABLE event_suggestion_batches ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE event_suggestion_batches DROP CONSTRAINT IF EXISTS event_suggestion_batches_origin_check;
ALTER TABLE event_suggestion_batches ADD CONSTRAINT event_suggestion_batches_origin_check CHECK (origin IN ('MANUAL','DIRECTOR_MAJOR'));

ALTER TABLE event_suggestions ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'MINOR';
ALTER TABLE event_suggestions DROP CONSTRAINT IF EXISTS event_suggestions_severity_check;
ALTER TABLE event_suggestions ADD CONSTRAINT event_suggestions_severity_check CHECK (severity IN ('MINOR','MAJOR'));
ALTER TABLE event_suggestions ADD COLUMN IF NOT EXISTS consequence TEXT NOT NULL DEFAULT '';
ALTER TABLE event_suggestions ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS story_repair_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_world_sequence BIGINT NOT NULL,
  proposal JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPLIED','REJECTED','STALE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS story_repair_proposals_one_pending_idx
ON story_repair_proposals(project_id) WHERE status='PENDING';

CREATE INDEX IF NOT EXISTS character_memories_active_retrieval_idx
ON character_memories(character_id,importance DESC,created_at DESC) WHERE archived_at IS NULL;
