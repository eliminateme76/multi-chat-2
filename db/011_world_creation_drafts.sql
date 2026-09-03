CREATE TABLE IF NOT EXISTS world_creation_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CREATED','CANCELLED')),
  thread_id TEXT,
  model TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL CHECK (reasoning_effort IN ('none','minimal','low','medium','high','xhigh','max','ultra')),
  draft_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS world_creation_drafts_status_updated_idx
ON world_creation_drafts(status,updated_at DESC);

CREATE TABLE IF NOT EXISTS world_creation_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id UUID NOT NULL REFERENCES world_creation_drafts(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  role TEXT NOT NULL CHECK (role IN ('USER','ASSISTANT')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(draft_id,sequence)
);

CREATE INDEX IF NOT EXISTS world_creation_messages_draft_sequence_idx
ON world_creation_messages(draft_id,sequence);
