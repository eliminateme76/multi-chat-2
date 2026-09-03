ALTER TABLE characters ADD COLUMN IF NOT EXISTS active_thread_turn_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS active_thread_context_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS thread_rollover_required BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS director_thread_turn_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS director_thread_context_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS director_thread_rollover_required BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS scene_entry_recipients_character_entry_idx
ON scene_entry_recipients(character_id,entry_id);
