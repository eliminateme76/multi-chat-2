import { randomUUID } from 'node:crypto';
import { cleanDramaticState, cleanStoryState, emptyDramaticState, emptyStoryState } from './story-dynamics.js';

const hasState = (value) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
const WORLD_PACKAGE_FORMAT = 'sceneweaver-world';
const WORLD_PACKAGE_VERSION = 1;

const packageText = (value, max, fallback = '') => typeof value === 'string' ? value.trim().slice(0, max) : fallback;

function validateWorldPackage(input) {
  const source = input?.worldPackage || input;
  if (!source || typeof source !== 'object' || source.format !== WORLD_PACKAGE_FORMAT || source.version !== WORLD_PACKAGE_VERSION) throw new Error('지원하지 않는 세계관 파일입니다.');
  const rawWorld = source.world && typeof source.world === 'object' ? source.world : {};
  const world = {
    title: packageText(rawWorld.title, 50), location: packageText(rawWorld.location, 70), mood: packageText(rawWorld.mood, 70),
    time: packageText(rawWorld.time, 40), description: packageText(rawWorld.description, 300), rules: packageText(rawWorld.rules, 300),
    presentationMode: ['scene','chat'].includes(rawWorld.presentationMode) ? rawWorld.presentationMode : 'scene',
    dramaIntensity: ['gentle','balanced','high'].includes(rawWorld.dramaIntensity) ? rawWorld.dramaIntensity : 'balanced'
  };
  if (!world.title || !world.location || !world.mood || !world.time || !world.description) throw new Error('세계관 파일의 필수 설정이 비어 있습니다.');
  if (!Array.isArray(source.characters) || source.characters.length < 1 || source.characters.length > 12) throw new Error('세계관 파일에는 캐릭터가 1~12명 있어야 합니다.');
  const keys = new Set();
  const characters = source.characters.map((raw, index) => {
    const key = packageText(raw?.key, 80, `character-${index + 1}`);
    if (!/^[a-z][a-z0-9_-]*$/i.test(key) || keys.has(key)) throw new Error('캐릭터 키가 올바르지 않거나 중복됩니다.');
    keys.add(key);
    const character = {
      key, name: packageText(raw?.name, 50), role: packageText(raw?.role, 80), gender: packageText(raw?.gender, 30, '성별 없음'),
      portraitUrl: packageText(raw?.portraitUrl, 2000), portraitPosition: packageText(raw?.portraitPosition, 20, '50%'), emoji: packageText(raw?.emoji, 12, '✧'),
      color: /^#[0-9a-f]{6}$/i.test(raw?.color || '') ? raw.color : '#5c9c9b', personality: packageText(raw?.personality, 240),
      speechStyle: packageText(raw?.speechStyle, 240), goal: packageText(raw?.goal, 240), secret: packageText(raw?.secret, 300), emotion: packageText(raw?.emotion, 80, '기대')
    };
    if (!character.name || !character.role || !character.personality || !character.speechStyle || !character.goal) throw new Error('캐릭터 필수 설정이 비어 있습니다.');
    return character;
  });
  const relationshipKeys = new Set();
  const relationships = (Array.isArray(source.relationships) ? source.relationships : []).map((raw) => {
    const from = packageText(raw?.from, 80); const to = packageText(raw?.to, 80); const pair = `${from}:${to}`;
    if (!keys.has(from) || !keys.has(to) || from === to || relationshipKeys.has(pair)) throw new Error('관계의 캐릭터 참조가 올바르지 않습니다.');
    relationshipKeys.add(pair);
    return { from, to, label: packageText(raw?.label, 120, '아직 정의되지 않은 관계'), score: Math.max(0, Math.min(100, Math.round(Number(raw?.score) || 0))) };
  });
  return {
    world, characters, relationships,
    attributeSchema: source.attributeSchema && typeof source.attributeSchema === 'object' ? source.attributeSchema : [],
    storyState: source.storyState && typeof source.storyState === 'object' ? source.storyState : {},
    dramaticState: source.dramaticState && typeof source.dramaticState === 'object' ? source.dramaticState : {}
  };
}

function seedInitialStoryState(world, characterIds) {
  if (hasState(world.storyState)) return cleanStoryState(world.storyState, characterIds);
  const summary = String(world.description || '인물들이 새로운 상황에서 각자의 목표를 향해 움직이기 시작한다.').trim();
  return cleanStoryState({
    ...emptyStoryState(),
    activeTensions: [{ id: randomUUID(), summary, involvedCharacterIds: characterIds, pressure: 35, introducedAtSequence: 0 }],
    openQuestions: [{ id: randomUUID(), text: '이 상황에서 인물들은 무엇을 선택할 것인가?', involvedCharacterIds: characterIds, urgency: 40, introducedAtSequence: 0 }]
  }, characterIds);
}

function seedInitialDramaticState(world, characterIds, storyState) {
  if (hasState(world.dramaticState)) return cleanDramaticState(world.dramaticState, characterIds);
  return cleanDramaticState({
    ...emptyDramaticState(),
    objective: '인물들이 현재 상황에 어떻게 대응할지 드러냅니다.',
    stakes: String(world.description || '').trim(),
    dilemma: '각자의 목표와 관계 속에서 첫 선택을 해야 합니다.',
    beatType: 'choice',
    targetTension: storyState.tension,
    participantIds: characterIds
  }, characterIds);
}

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
    const characterIds = (await client.query('SELECT id FROM characters WHERE project_id=$1 ORDER BY sort_order', [projectId])).rows.map((row) => row.id);
    world.storyState = seedInitialStoryState(world, characterIds);
    world.dramaticState = seedInitialDramaticState(world, characterIds, world.storyState);
    await client.query('UPDATE relationships SET label=COALESCE(initial_label,label),score=COALESCE(initial_score,score),updated_at=NOW() WHERE project_id=$1', [projectId]);
    await client.query(`UPDATE projects SET title=$2,location=$3,mood=$4,scene_time=$5,description=$6,rules=$7,
      scene_number=1,turn_number=0,next_event_sequence=1,public_direction='인물들이 현재 상황에서 자연스럽게 대화를 시작합니다.',private_director_state='',
      active_director_thread_id=NULL,director_thread_turn_count=0,director_thread_context_tokens=0,director_thread_rollover_required=FALSE,last_director_event_sequence=NULL,drama_intensity=$8,story_state=$9,
      initial_world=initial_world || $10::jsonb,updated_at=NOW() WHERE id=$1`,
    [projectId, world.title, world.location, world.mood, world.time, world.description, world.rules, world.dramaIntensity, JSON.stringify(world.storyState), JSON.stringify({ storyState: world.storyState, dramaticState: world.dramaticState })]);
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
    const targetCharacterIds = [...idMap.values()];
    const remapIds = (items = []) => items.map((item) => ({ ...item, involvedCharacterIds: (item.involvedCharacterIds || []).map((id) => idMap.get(id)).filter(Boolean) }));
    const remappedStoryState = hasState(world.storyState) ? { ...world.storyState, activeTensions: remapIds(world.storyState.activeTensions), openQuestions: remapIds(world.storyState.openQuestions), recentBeats: [], lastDirectorSequence: 0 } : {};
    const remappedDramaticState = hasState(world.dramaticState) ? { ...world.dramaticState, participantIds: (world.dramaticState.participantIds || []).map((id) => idMap.get(id)).filter(Boolean) } : {};
    const clonedStoryState = seedInitialStoryState({ ...world, storyState: remappedStoryState }, targetCharacterIds);
    world.dramaticState = seedInitialDramaticState({ ...world, dramaticState: remappedDramaticState }, targetCharacterIds, clonedStoryState);
    world.storyState = clonedStoryState;
    await client.query('UPDATE projects SET story_state=$2,initial_world=initial_world || $3::jsonb WHERE id=$1', [targetProjectId, JSON.stringify(clonedStoryState), JSON.stringify({ storyState: clonedStoryState, dramaticState: world.dramaticState })]);
    await insertInitialScene(client, targetProjectId, world);
    await client.query('COMMIT');
    return targetProjectId;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function exportWorldPackage(pool, projectId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const source = await lockProject(client, projectId);
    const world = initialWorld(source);
    const characters = (await client.query('SELECT * FROM characters WHERE project_id=$1 ORDER BY sort_order', [projectId])).rows;
    const relationships = (await client.query('SELECT * FROM relationships WHERE project_id=$1 ORDER BY created_at', [projectId])).rows;
    const keyById = new Map(characters.map((character, index) => [character.id, `character-${index + 1}`]));
    const characterIds = characters.map((character) => character.id);
    const storyState = seedInitialStoryState(world, characterIds);
    const dramaticState = seedInitialDramaticState(world, characterIds, storyState);
    await client.query('COMMIT');
    return {
      format: WORLD_PACKAGE_FORMAT, version: WORLD_PACKAGE_VERSION, exportedAt: new Date().toISOString(),
      world: { title: world.title, location: world.location, mood: world.mood, time: world.time, description: world.description, rules: world.rules, presentationMode: world.presentationMode, dramaIntensity: world.dramaIntensity },
      attributeSchema: source.attributeSchema || [],
      characters: characters.map((character) => {
        const profile = character.initial_profile || {};
        return {
          key: keyById.get(character.id), name: profile.name || character.name, role: profile.role || character.role, gender: profile.gender || character.gender,
          portraitUrl: character.portrait_url || '', portraitPosition: character.portrait_position || '50%', emoji: character.emoji, color: character.color,
          personality: profile.personality || character.personality, speechStyle: profile.speechStyle || character.speech_style,
          goal: profile.goal || character.goal, secret: profile.secret || character.secret, emotion: profile.emotion || '기대'
        };
      }),
      relationships: relationships.map((relationship) => ({ from: keyById.get(relationship.from_character_id), to: keyById.get(relationship.to_character_id), label: relationship.initial_label || relationship.label, score: relationship.initial_score ?? relationship.score })),
      storyState: {
        ...storyState, recentBeats: [], lastDirectorSequence: 0,
        activeTensions: storyState.activeTensions.map(({ involvedCharacterIds, ...item }) => ({ ...item, introducedAtSequence: 0, involvedCharacterKeys: involvedCharacterIds.map((id) => keyById.get(id)).filter(Boolean) })),
        openQuestions: storyState.openQuestions.map(({ involvedCharacterIds, ...item }) => ({ ...item, introducedAtSequence: 0, involvedCharacterKeys: involvedCharacterIds.map((id) => keyById.get(id)).filter(Boolean) }))
      },
      dramaticState: {
        objective: dramaticState.objective, stakes: dramaticState.stakes, dilemma: dramaticState.dilemma, beatType: dramaticState.beatType,
        targetTension: dramaticState.targetTension, worldPhase: dramaticState.worldPhase, lastWorldOutcome: dramaticState.lastWorldOutcome,
        worldPressure: dramaticState.worldPressure, worldRelief: dramaticState.worldRelief,
        participantKeys: dramaticState.participantIds.map((id) => keyById.get(id)).filter(Boolean)
      }
    };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function importWorldPackage(pool, input) {
  const portable = validateWorldPackage(input);
  const client = await pool.connect();
  const projectId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO projects(id,title,location,mood,scene_time,description,rules,public_direction,private_director_state,attribute_schema,next_event_sequence,initial_world,drama_intensity,story_state)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'인물들이 현재 상황에서 자연스럽게 대화를 시작합니다.','',$8,1,$9,$10,'{}'::jsonb)`,
    [projectId, portable.world.title, portable.world.location, portable.world.mood, portable.world.time, portable.world.description, portable.world.rules, JSON.stringify(portable.attributeSchema), JSON.stringify(portable.world), portable.world.dramaIntensity]);
    const idByKey = new Map();
    for (const [index, character] of portable.characters.entries()) {
      const id = randomUUID(); idByKey.set(character.key, id);
      const profile = { name: character.name, role: character.role, gender: character.gender, personality: character.personality, speechStyle: character.speechStyle, goal: character.goal, secret: character.secret, emotion: character.emotion };
      await client.query(`INSERT INTO characters(id,project_id,name,role,gender,portrait_url,portrait_position,emoji,color,personality,speech_style,goal,secret,emotion,sort_order,initial_profile,current_state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,jsonb_build_object('currentGoal',$12::text,'internalConflict','','beliefs','[]'::jsonb,'commitments','[]'::jsonb,'developmentNotes','[]'::jsonb,'lastChangedSequence',0))`,
      [id,projectId,character.name,character.role,character.gender,character.portraitUrl,character.portraitPosition,character.emoji,character.color,character.personality,character.speechStyle,character.goal,character.secret,character.emotion,index,JSON.stringify(profile)]);
    }
    for (const relationship of portable.relationships) await client.query(`INSERT INTO relationships(id,project_id,from_character_id,to_character_id,label,score,initial_label,initial_score)
      VALUES ($1,$2,$3,$4,$5,$6,$5,$6)`, [randomUUID(),projectId,idByKey.get(relationship.from),idByKey.get(relationship.to),relationship.label,relationship.score]);
    const characterIds = [...idByKey.values()];
    const storyInput = {
      ...portable.storyState, recentBeats: [], lastDirectorSequence: 0,
      activeTensions: (Array.isArray(portable.storyState.activeTensions) ? portable.storyState.activeTensions : []).map(({ involvedCharacterKeys, ...item }) => ({ ...item, introducedAtSequence: 0, involvedCharacterIds: (involvedCharacterKeys || []).map((key) => idByKey.get(key)).filter(Boolean) })),
      openQuestions: (Array.isArray(portable.storyState.openQuestions) ? portable.storyState.openQuestions : []).map(({ involvedCharacterKeys, ...item }) => ({ ...item, introducedAtSequence: 0, involvedCharacterIds: (involvedCharacterKeys || []).map((key) => idByKey.get(key)).filter(Boolean) }))
    };
    const storyState = seedInitialStoryState({ ...portable.world, storyState: storyInput }, characterIds);
    const dramaticInput = { ...portable.dramaticState, participantIds: (portable.dramaticState.participantKeys || []).map((key) => idByKey.get(key)).filter(Boolean), plannedResponderIds: [], planResponderIds: [], planStartedSequence: 0, responsesConsumed: 0, planAction: '', planRationale: '', planOperationId: '' };
    const dramaticState = seedInitialDramaticState({ ...portable.world, dramaticState: dramaticInput }, characterIds, storyState);
    const initial = { ...portable.world, storyState, dramaticState };
    await client.query('UPDATE projects SET story_state=$2,initial_world=$3 WHERE id=$1', [projectId, JSON.stringify(storyState), JSON.stringify(initial)]);
    await insertInitialScene(client, projectId, initial);
    await client.query('COMMIT');
    return projectId;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
