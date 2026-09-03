import { randomUUID } from 'node:crypto';

const initialWorld = (project) => {
  const saved = project.initialWorld || {};
  return {
    title: saved.title || project.title,
    location: saved.location || project.location,
    mood: saved.mood || project.mood,
    time: saved.time || project.sceneTime,
    description: saved.description || project.description,
    rules: saved.rules ?? project.rules,
    presentationMode: saved.presentationMode || 'scene',
    dramaIntensity: saved.dramaIntensity || project.dramaIntensity || 'balanced',
    storyState: saved.storyState || {}, dramaticState: saved.dramaticState || {}
  };
};

async function lockProject(client, projectId) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [projectId]);
  const project = (await client.query(`SELECT id,title,location,mood,scene_time AS "sceneTime",description,rules,default_model AS "defaultModel",
    default_reasoning_effort AS "defaultReasoningEffort",director_model AS "directorModel",director_reasoning_effort AS "directorReasoningEffort",
    utility_model AS "utilityModel",utility_reasoning_effort AS "utilityReasoningEffort",attribute_schema AS "attributeSchema",initial_world AS "initialWorld",drama_intensity AS "dramaIntensity"
    FROM projects WHERE id=$1 FOR UPDATE`, [projectId])).rows[0];
  if (!project) throw new Error('Project not found.');
  return project;
}

async function insertInitialScene(client, projectId, world) {
  const sceneId = randomUUID();
  await client.query(`INSERT INTO scenes(id,project_id,scene_number,location,mood,scene_time,description,summary,public_direction,private_director_state,presentation_mode,dramatic_state)
    VALUES ($1,$2,1,$3,$4,$5,$6,$6,'인물들이 현재 상황에서 자연스럽게 대화를 시작합니다.','',$7,$8)`,
  [sceneId, projectId, world.location, world.mood, world.time, world.description, world.presentationMode, JSON.stringify(world.dramaticState || {})]);
  await client.query(`INSERT INTO scene_participants(scene_id,character_id,joined_sequence)
    SELECT $1,id,0 FROM characters WHERE project_id=$2`, [sceneId, projectId]);
  return sceneId;
}

export async function resetPlaythrough(pool, projectId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const project = await lockProject(client, projectId);
    const world = initialWorld(project);
    await client.query('DELETE FROM world_operations WHERE project_id=$1', [projectId]);
    await client.query('DELETE FROM story_repair_proposals WHERE project_id=$1', [projectId]);
    await client.query('DELETE FROM character_change_proposals WHERE project_id=$1', [projectId]);
    await client.query('DELETE FROM character_memories WHERE project_id=$1', [projectId]);
    await client.query('DELETE FROM scenes WHERE project_id=$1', [projectId]);
    await client.query(`UPDATE characters SET
      name=COALESCE(NULLIF(initial_profile->>'name',''),name),role=COALESCE(NULLIF(initial_profile->>'role',''),role),
      gender=COALESCE(NULLIF(initial_profile->>'gender',''),gender),personality=COALESCE(NULLIF(initial_profile->>'personality',''),personality),
      speech_style=COALESCE(NULLIF(initial_profile->>'speechStyle',''),speech_style),goal=COALESCE(NULLIF(initial_profile->>'goal',''),goal),
      secret=COALESCE(NULLIF(initial_profile->>'secret',''),secret),emotion=COALESCE(NULLIF(initial_profile->>'emotion',''),'기대'),
      current_state=jsonb_build_object('currentGoal',COALESCE(NULLIF(initial_profile->>'goal',''),goal),'internalConflict','','beliefs','[]'::jsonb,'commitments','[]'::jsonb,'developmentNotes','[]'::jsonb,'lastChangedSequence',0),active_thread_id=NULL,active_thread_turn_count=0,active_thread_context_tokens=0,thread_rollover_required=FALSE,last_scanned_event_sequence=NULL,pending_operation_step_id=NULL,updated_at=NOW()
      WHERE project_id=$1`, [projectId]);
    await client.query('UPDATE relationships SET label=COALESCE(initial_label,label),score=COALESCE(initial_score,score),updated_at=NOW() WHERE project_id=$1', [projectId]);
    await client.query(`UPDATE projects SET title=$2,location=$3,mood=$4,scene_time=$5,description=$6,rules=$7,
      scene_number=1,turn_number=0,next_event_sequence=1,public_direction='인물들이 현재 상황에서 자연스럽게 대화를 시작합니다.',private_director_state='',
      active_director_thread_id=NULL,director_thread_turn_count=0,director_thread_context_tokens=0,director_thread_rollover_required=FALSE,last_director_event_sequence=NULL,drama_intensity=$8,story_state=$9,updated_at=NOW() WHERE id=$1`,
    [projectId, world.title, world.location, world.mood, world.time, world.description, world.rules, world.dramaIntensity, JSON.stringify(world.storyState || {})]);
    await insertInitialScene(client, projectId, world);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function clonePlaythrough(pool, sourceProjectId, requestedTitle = '') {
  const client = await pool.connect();
  const targetProjectId = randomUUID();
  try {
    await client.query('BEGIN');
    const source = await lockProject(client, sourceProjectId);
    const world = initialWorld(source);
    world.title = requestedTitle.trim() || `${world.title} · 새 진행`;
    await client.query(`INSERT INTO projects(id,title,location,mood,scene_time,description,rules,public_direction,private_director_state,default_model,default_reasoning_effort,director_model,director_reasoning_effort,utility_model,utility_reasoning_effort,attribute_schema,next_event_sequence,initial_world,drama_intensity,story_state)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'인물들이 현재 상황에서 자연스럽게 대화를 시작합니다.','',$8,$9,$10,$11,$12,$13,$14,1,$15,$16,'{}'::jsonb)`,
    [targetProjectId, world.title, world.location, world.mood, world.time, world.description, world.rules, source.defaultModel, source.defaultReasoningEffort, source.directorModel, source.directorReasoningEffort, source.utilityModel, source.utilityReasoningEffort, source.attributeSchema, JSON.stringify({ ...world, title: world.title }), world.dramaIntensity]);
    const characters = (await client.query('SELECT * FROM characters WHERE project_id=$1 ORDER BY sort_order', [sourceProjectId])).rows;
    const idMap = new Map();
    for (const character of characters) {
      const id = randomUUID(); idMap.set(character.id, id);
      const profile = character.initial_profile || {};
      await client.query(`INSERT INTO characters(id,project_id,origin_character_id,name,role,gender,portrait_url,portrait_position,emoji,color,personality,speech_style,goal,secret,emotion,sort_order,model_override,reasoning_effort_override,initial_profile,current_state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,jsonb_build_object('currentGoal',$13::text,'internalConflict','','beliefs','[]'::jsonb,'commitments','[]'::jsonb,'developmentNotes','[]'::jsonb,'lastChangedSequence',0))`,
      [id,targetProjectId,character.id,profile.name||character.name,profile.role||character.role,profile.gender||character.gender,character.portrait_url,character.portrait_position,character.emoji,character.color,profile.personality||character.personality,profile.speechStyle||character.speech_style,profile.goal||character.goal,profile.secret||character.secret,profile.emotion||'기대',character.sort_order,character.model_override,character.reasoning_effort_override,character.initial_profile]);
    }
    const relationships = (await client.query('SELECT * FROM relationships WHERE project_id=$1', [sourceProjectId])).rows;
    for (const relationship of relationships) await client.query(`INSERT INTO relationships(id,project_id,from_character_id,to_character_id,label,score,initial_label,initial_score)
      VALUES ($1,$2,$3,$4,$5,$6,$5,$6)`, [randomUUID(),targetProjectId,idMap.get(relationship.from_character_id),idMap.get(relationship.to_character_id),relationship.initial_label||relationship.label,relationship.initial_score??relationship.score]);
    const remapIds = (items = []) => items.map((item) => ({ ...item, involvedCharacterIds: (item.involvedCharacterIds || []).map((id) => idMap.get(id)).filter(Boolean) }));
    const clonedStoryState = Object.keys(world.storyState || {}).length ? { ...world.storyState, activeTensions: remapIds(world.storyState.activeTensions), openQuestions: remapIds(world.storyState.openQuestions), recentBeats: [], lastDirectorSequence: 0 } : {};
    world.dramaticState = Object.keys(world.dramaticState || {}).length ? { ...world.dramaticState, participantIds: (world.dramaticState.participantIds || []).map((id) => idMap.get(id)).filter(Boolean) } : {};
    await client.query('UPDATE projects SET story_state=$2,initial_world=initial_world || $3::jsonb WHERE id=$1', [targetProjectId, JSON.stringify(clonedStoryState), JSON.stringify({ storyState: clonedStoryState, dramaticState: world.dramaticState })]);
    await insertInitialScene(client, targetProjectId, world);
    await client.query('COMMIT');
    return targetProjectId;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
