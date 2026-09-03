WITH candidates AS (
  SELECT p.id,
    COALESCE(NULLIF(BTRIM(p.description),''),'인물들이 새로운 상황에서 각자의 목표를 향해 움직이기 시작한다.') AS description,
    COALESCE((SELECT jsonb_agg(to_jsonb(c.id) ORDER BY c.sort_order) FROM characters c WHERE c.project_id=p.id),'[]'::jsonb) AS character_ids
  FROM projects p
  WHERE p.story_state='{}'::jsonb
    AND NOT EXISTS (SELECT 1 FROM scene_entries e WHERE e.project_id=p.id)
), seeded AS (
  SELECT id,
    jsonb_build_object(
      'version',1,'arcPhase','setup','tension',35,'pacing','steady',
      'activeTensions',jsonb_build_array(jsonb_build_object(
        'id',gen_random_uuid()::text,'summary',LEFT(description,240),'involvedCharacterIds',character_ids,'pressure',35,'introducedAtSequence',0)),
      'openQuestions',jsonb_build_array(jsonb_build_object(
        'id',gen_random_uuid()::text,'text','이 상황에서 인물들은 무엇을 선택할 것인가?','involvedCharacterIds',character_ids,'urgency',40,'introducedAtSequence',0)),
      'recentBeats','[]'::jsonb,
      'rhythm',jsonb_build_object('phase','build','lastOutcome','open','repeatedOutcomeCount',0,'consecutiveRises',0,'lastTensionDirection','hold'),
      'lastDirectorSequence',0
    ) AS story_state,
    jsonb_build_object(
      'objective','인물들이 현재 상황에 어떻게 대응할지 드러냅니다.','stakes',LEFT(description,240),
      'dilemma','각자의 목표와 관계 속에서 첫 선택을 해야 합니다.','beatType','choice','targetTension',35,
      'participantIds',character_ids,'worldPhase','build','lastWorldOutcome','open','worldPressure','','worldRelief','',
      'plannedResponderIds','[]'::jsonb,'planResponderIds','[]'::jsonb,'planStartedSequence',0,'responsesConsumed',0,
      'planAction','','planRationale','','planOperationId',''
    ) AS dramatic_state
  FROM candidates
), updated_scenes AS (
  UPDATE scenes s SET dramatic_state=seeded.dramatic_state,updated_at=NOW()
  FROM seeded
  WHERE s.project_id=seeded.id AND s.status='active' AND s.dramatic_state='{}'::jsonb
  RETURNING s.id
)
UPDATE projects p SET
  story_state=seeded.story_state,
  initial_world=COALESCE(p.initial_world,'{}'::jsonb) || jsonb_build_object('storyState',seeded.story_state,'dramaticState',seeded.dramatic_state),
  updated_at=NOW()
FROM seeded
WHERE p.id=seeded.id;

UPDATE story_repair_proposals r SET status='STALE',decided_at=NOW()
WHERE r.status='PENDING'
  AND NOT EXISTS (SELECT 1 FROM scene_entries e WHERE e.project_id=r.project_id);
