ALTER TABLE scenes ADD COLUMN IF NOT EXISTS presentation_mode TEXT NOT NULL DEFAULT 'scene';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='scenes_presentation_mode_check') THEN
    ALTER TABLE scenes ADD CONSTRAINT scenes_presentation_mode_check CHECK (presentation_mode IN ('scene','chat'));
  END IF;
END $$;
