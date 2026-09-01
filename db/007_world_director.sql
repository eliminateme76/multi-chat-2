ALTER TABLE projects ADD COLUMN IF NOT EXISTS active_director_thread_id TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_director_event_sequence BIGINT;

CREATE TABLE IF NOT EXISTS event_suggestion_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_scene_id UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  source_world_sequence BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUPERSEDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS event_suggestion_batches_project_scene_idx ON event_suggestion_batches(project_id,source_scene_id,created_at DESC);

CREATE TABLE IF NOT EXISTS event_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES event_suggestion_batches(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_scene_id UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  text TEXT NOT NULL,
  scene_time TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','APPLIED','DISCARDED')),
  applied_entry_id UUID REFERENCES scene_entries(id) ON DELETE SET NULL,
  applied_scene_id UUID REFERENCES scenes(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS event_suggestions_project_scene_idx ON event_suggestions(project_id,source_scene_id,status,created_at DESC);
