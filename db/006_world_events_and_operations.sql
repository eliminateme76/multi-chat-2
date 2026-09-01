CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS default_model TEXT NOT NULL DEFAULT 'gpt-5.6-sol';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS attribute_schema JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS next_event_sequence BIGINT NOT NULL DEFAULT 1;

ALTER TABLE characters ADD COLUMN IF NOT EXISTS origin_character_id UUID REFERENCES characters(id) ON DELETE SET NULL;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS active_thread_id TEXT;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS last_scanned_event_sequence BIGINT;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS model_override TEXT;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS initial_profile JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS current_state JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS pending_operation_step_id UUID;

UPDATE characters
SET initial_profile=jsonb_build_object('name',name,'role',role,'gender',gender,'personality',personality,'speechStyle',speech_style,'goal',goal,'secret',secret,'emotion',emotion)
WHERE initial_profile='{}'::jsonb;

CREATE TABLE IF NOT EXISTS scene_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  joined_sequence BIGINT NOT NULL DEFAULT 0,
  left_sequence BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (left_sequence IS NULL OR left_sequence >= joined_sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS scene_participants_one_active_idx ON scene_participants(scene_id,character_id) WHERE left_sequence IS NULL;

ALTER TABLE scene_entries ADD COLUMN IF NOT EXISTS world_sequence BIGINT;
ALTER TABLE scene_entries ADD COLUMN IF NOT EXISTS actor_type TEXT;
ALTER TABLE scene_entries ADD COLUMN IF NOT EXISTS event_kind TEXT;
ALTER TABLE scene_entries ADD COLUMN IF NOT EXISTS visibility_scope TEXT NOT NULL DEFAULT 'PARTICIPANTS';
ALTER TABLE scene_entries ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE scene_entries DROP CONSTRAINT IF EXISTS messages_have_content;
ALTER TABLE scene_entries DROP CONSTRAINT IF EXISTS scene_entries_actor_type_check;
ALTER TABLE scene_entries ADD CONSTRAINT scene_entries_actor_type_check CHECK (actor_type IS NULL OR actor_type IN ('USER','CHARACTER','DIRECTOR','SYSTEM'));
ALTER TABLE scene_entries DROP CONSTRAINT IF EXISTS scene_entries_visibility_scope_check;
ALTER TABLE scene_entries ADD CONSTRAINT scene_entries_visibility_scope_check CHECK (visibility_scope IN ('PARTICIPANTS','ACTOR_ONLY','RECIPIENTS','WORLD'));

WITH ordered AS (
  SELECT e.id, row_number() OVER (PARTITION BY e.project_id ORDER BY s.scene_number,e.sort_order,e.created_at,e.id) AS seq
  FROM scene_entries e JOIN scenes s ON s.id=e.scene_id
)
UPDATE scene_entries e SET world_sequence=ordered.seq FROM ordered WHERE e.id=ordered.id AND e.world_sequence IS NULL;
UPDATE scene_entries SET actor_type=CASE WHEN character_id IS NULL THEN 'DIRECTOR' ELSE 'CHARACTER' END WHERE actor_type IS NULL;
UPDATE scene_entries SET event_kind=CASE WHEN entry_type='message' THEN 'CHARACTER_RESPONSE' ELSE 'DIRECTOR_EVENT' END WHERE event_kind IS NULL;
UPDATE scene_entries SET payload=jsonb_strip_nulls(jsonb_build_object('dialogue',dialogue,'action',action,'text',event_text,'eventType',event_type)) WHERE payload='{}'::jsonb;
ALTER TABLE scene_entries ALTER COLUMN world_sequence SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS scene_entries_project_sequence_idx ON scene_entries(project_id,world_sequence);

INSERT INTO scene_participants(scene_id,character_id,joined_sequence)
SELECT s.id,c.id,0 FROM scenes s JOIN characters c ON c.project_id=s.project_id
WHERE NOT EXISTS (SELECT 1 FROM scene_participants sp WHERE sp.scene_id=s.id AND sp.character_id=c.id AND sp.left_sequence IS NULL);

CREATE TABLE IF NOT EXISTS scene_entry_recipients (
  entry_id UUID NOT NULL REFERENCES scene_entries(id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  PRIMARY KEY(entry_id,character_id)
);
INSERT INTO scene_entry_recipients(entry_id,character_id)
SELECT e.id,sp.character_id FROM scene_entries e JOIN scene_participants sp ON sp.scene_id=e.scene_id
WHERE e.visibility_scope='PARTICIPANTS' ON CONFLICT DO NOTHING;

UPDATE projects p SET next_event_sequence=GREATEST(p.next_event_sequence,COALESCE((SELECT MAX(world_sequence)+1 FROM scene_entries e WHERE e.project_id=p.id),1));

INSERT INTO relationships(id,project_id,from_character_id,to_character_id,label,score)
SELECT gen_random_uuid(),r.project_id,r.to_character_id,r.from_character_id,r.label,r.score FROM relationships r
WHERE NOT EXISTS (SELECT 1 FROM relationships reverse_r WHERE reverse_r.project_id=r.project_id AND reverse_r.from_character_id=r.to_character_id AND reverse_r.to_character_id=r.from_character_id);

CREATE TABLE IF NOT EXISTS character_change_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  source_entry_id UUID REFERENCES scene_entries(id) ON DELETE SET NULL,
  change_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('MINOR','MAJOR')),
  patch JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPLIED','REJECTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS world_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('PROGRESSION','DIRECTOR_EVENT','USER_MESSAGE','SCENE_CREATE','PARTICIPANT_CHANGE')),
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS world_operations_queue_idx ON world_operations(project_id,status,created_at);

CREATE TABLE IF NOT EXISTS world_operation_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL REFERENCES world_operations(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  character_id UUID REFERENCES characters(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED')),
  thread_id TEXT,
  entry_id UUID REFERENCES scene_entries(id) ON DELETE SET NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE(operation_id,step_order)
);
