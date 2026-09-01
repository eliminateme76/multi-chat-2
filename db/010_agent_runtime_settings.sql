ALTER TABLE projects ADD COLUMN IF NOT EXISTS default_reasoning_effort TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS director_model TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS director_reasoning_effort TEXT NOT NULL DEFAULT 'high';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS utility_model TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS utility_reasoning_effort TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE characters ADD COLUMN IF NOT EXISTS reasoning_effort_override TEXT;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_default_reasoning_effort_check;
ALTER TABLE projects ADD CONSTRAINT projects_default_reasoning_effort_check CHECK (default_reasoning_effort IN ('none','minimal','low','medium','high','xhigh','max','ultra'));
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_director_reasoning_effort_check;
ALTER TABLE projects ADD CONSTRAINT projects_director_reasoning_effort_check CHECK (director_reasoning_effort IN ('none','minimal','low','medium','high','xhigh','max','ultra'));
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_utility_reasoning_effort_check;
ALTER TABLE projects ADD CONSTRAINT projects_utility_reasoning_effort_check CHECK (utility_reasoning_effort IN ('none','minimal','low','medium','high','xhigh','max','ultra'));
ALTER TABLE characters DROP CONSTRAINT IF EXISTS characters_reasoning_effort_override_check;
ALTER TABLE characters ADD CONSTRAINT characters_reasoning_effort_override_check CHECK (reasoning_effort_override IS NULL OR reasoning_effort_override IN ('none','minimal','low','medium','high','xhigh','max','ultra'));
