CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS public_direction TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS private_director_state TEXT NOT NULL DEFAULT '';

UPDATE projects
SET private_director_state = director_note
WHERE private_director_state = '' AND director_note <> '';

UPDATE projects
SET public_direction = '각 인물은 공개된 정보와 자신의 관점에 따라 행동합니다.'
WHERE public_direction = '';

CREATE TABLE IF NOT EXISTS scenes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_number INTEGER NOT NULL CHECK (scene_number > 0),
  location TEXT NOT NULL,
  mood TEXT NOT NULL,
  scene_time TEXT NOT NULL,
  description TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  public_direction TEXT NOT NULL DEFAULT '',
  private_director_state TEXT NOT NULL DEFAULT '',
  progress_signal TEXT NOT NULL DEFAULT 'continue' CHECK (progress_signal IN ('continue', 'stalled', 'complete')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, scene_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS scenes_one_active_per_project_idx
ON scenes(project_id) WHERE status='active';

INSERT INTO scenes (project_id,scene_number,location,mood,scene_time,description,summary,public_direction,private_director_state)
SELECT p.id,p.scene_number,p.location,p.mood,p.scene_time,p.description,p.description,p.public_direction,p.private_director_state
FROM projects p
WHERE NOT EXISTS (SELECT 1 FROM scenes s WHERE s.project_id=p.id);

ALTER TABLE scene_entries ADD COLUMN IF NOT EXISTS scene_id UUID REFERENCES scenes(id) ON DELETE CASCADE;

UPDATE scene_entries e
SET scene_id = s.id
FROM scenes s
WHERE e.scene_id IS NULL AND s.project_id=e.project_id AND s.status='active';

CREATE INDEX IF NOT EXISTS scene_entries_scene_sort_idx ON scene_entries(scene_id, sort_order);

CREATE TABLE IF NOT EXISTS character_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  source_entry_id UUID REFERENCES scene_entries(id) ON DELETE SET NULL,
  memory_text TEXT NOT NULL,
  emotion TEXT NOT NULL DEFAULT '',
  importance INTEGER NOT NULL DEFAULT 50 CHECK (importance BETWEEN 0 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS character_memories_retrieval_idx
ON character_memories(character_id, importance DESC, created_at DESC);
