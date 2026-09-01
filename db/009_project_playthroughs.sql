ALTER TABLE projects ADD COLUMN IF NOT EXISTS initial_world JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE projects p SET initial_world=jsonb_build_object(
  'title',p.title,
  'location',COALESCE((SELECT location FROM scenes WHERE project_id=p.id ORDER BY scene_number LIMIT 1),p.location),
  'mood',COALESCE((SELECT mood FROM scenes WHERE project_id=p.id ORDER BY scene_number LIMIT 1),p.mood),
  'time',COALESCE((SELECT scene_time FROM scenes WHERE project_id=p.id ORDER BY scene_number LIMIT 1),p.scene_time),
  'description',COALESCE((SELECT description FROM scenes WHERE project_id=p.id ORDER BY scene_number LIMIT 1),p.description),
  'rules',p.rules,
  'presentationMode',COALESCE((SELECT presentation_mode FROM scenes WHERE project_id=p.id ORDER BY scene_number LIMIT 1),'scene')
)
WHERE p.initial_world='{}'::jsonb;

UPDATE projects SET initial_world=jsonb_build_object(
  'title',title,'location',location,'mood',mood,'time',scene_time,
  'description',description,'rules',rules,'presentationMode','scene'
) WHERE initial_world='{}'::jsonb;

ALTER TABLE relationships ADD COLUMN IF NOT EXISTS initial_label TEXT;
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS initial_score INTEGER CHECK (initial_score BETWEEN 0 AND 100);
UPDATE relationships SET initial_label=label WHERE initial_label IS NULL;
UPDATE relationships SET initial_score=score WHERE initial_score IS NULL;
