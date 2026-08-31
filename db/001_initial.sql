CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  location TEXT NOT NULL,
  mood TEXT NOT NULL,
  scene_time TEXT NOT NULL,
  description TEXT NOT NULL,
  rules TEXT NOT NULL DEFAULT '',
  scene_number INTEGER NOT NULL DEFAULT 1 CHECK (scene_number > 0),
  turn_number INTEGER NOT NULL DEFAULT 0 CHECK (turn_number >= 0),
  director_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS characters (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '✧',
  color TEXT NOT NULL DEFAULT '#5c9c9b',
  personality TEXT NOT NULL,
  speech_style TEXT NOT NULL,
  goal TEXT NOT NULL,
  secret TEXT NOT NULL,
  emotion TEXT NOT NULL DEFAULT '기대',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS characters_project_sort_idx ON characters(project_id, sort_order);

CREATE TABLE IF NOT EXISTS relationships (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  to_character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT relationships_unique_direction UNIQUE(project_id, from_character_id, to_character_id),
  CONSTRAINT relationships_no_self CHECK(from_character_id <> to_character_id)
);

CREATE TABLE IF NOT EXISTS scene_entries (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL CHECK(entry_type IN ('message', 'event')),
  character_id UUID REFERENCES characters(id) ON DELETE SET NULL,
  dialogue TEXT,
  action TEXT,
  event_text TEXT,
  sort_order INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT messages_have_content CHECK (
    (entry_type = 'message' AND character_id IS NOT NULL AND dialogue IS NOT NULL AND action IS NOT NULL AND event_text IS NULL)
    OR (entry_type = 'event' AND character_id IS NULL AND event_text IS NOT NULL AND dialogue IS NULL AND action IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS scene_entries_project_sort_idx ON scene_entries(project_id, sort_order);