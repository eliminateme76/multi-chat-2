ALTER TABLE scene_participants ADD COLUMN IF NOT EXISTS idle_at_sequence BIGINT;
ALTER TABLE scene_participants ADD COLUMN IF NOT EXISTS idle_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE scene_participants ADD COLUMN IF NOT EXISTS idle_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS scene_participants_idle_idx
ON scene_participants(scene_id,idle_at_sequence) WHERE left_sequence IS NULL;
