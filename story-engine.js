import { randomUUID } from 'node:crypto';
import { publicDirectionForSignal } from './orchestrator.js';
import { selectNextSpeaker } from './speaker-selector.js';
import { endStage, failStage, startStage } from './runtime-telemetry.js';

export async function getStoryState(queryable, projectId) {
  const project = (await queryable.query(`
    SELECT p.id,p.title,p.rules,p.turn_number AS turn,
      s.id AS "sceneId",s.scene_number AS "sceneNumber",s.location,s.mood,s.scene_time AS time,
      s.description,s.summary AS "sceneSummary",s.public_direction AS "publicDirection",s.presentation_mode AS "presentationMode",
      s.progress_signal AS "sceneSignal"
    FROM projects p
    LEFT JOIN LATERAL (
      SELECT * FROM scenes WHERE project_id=p.id AND status='active' ORDER BY scene_number DESC LIMIT 1
    ) s ON TRUE
    WHERE p.id=$1`, [projectId])).rows[0];
  if (!project || !project.sceneId) return null;
  const characters = await queryable.query(`SELECT c.id,c.name,c.role,c.gender,c.portrait_url AS "portraitUrl",c.portrait_position AS "portraitPosition",c.emoji,c.color,c.personality,c.speech_style AS "speechStyle",c.goal,c.secret,c.emotion,
    active_thread_id AS "activeThreadId",model_override AS "modelOverride",COALESCE(model_override,p.default_model) AS "effectiveModel",current_state AS "currentState",last_scanned_event_sequence AS "lastScannedEventSequence"
    FROM characters c JOIN projects p ON p.id=c.project_id WHERE c.project_id=$1 ORDER BY sort_order`, [projectId]);
  const relationships = await queryable.query('SELECT from_character_id AS "from",to_character_id AS "to",label,score FROM relationships WHERE project_id=$1 ORDER BY created_at', [projectId]);
  const participantStates = await queryable.query(`SELECT sp.character_id AS "characterId",sp.idle_at_sequence AS "idleAtSequence",sp.idle_reason AS "idleReason",sp.idle_at AS "idleAt"
    FROM scene_participants sp WHERE sp.scene_id=$1 AND sp.left_sequence IS NULL`, [project.sceneId]);
  const latestSceneSequence = Number((await queryable.query('SELECT COALESCE(MAX(world_sequence),0) AS sequence FROM scene_entries WHERE scene_id=$1', [project.sceneId])).rows[0].sequence);
  const participants = participantStates.rows.map((participant) => ({ ...participant, idle: participant.idleAtSequence != null && Number(participant.idleAtSequence) >= latestSceneSequence }));
  const entries = await queryable.query(`SELECT e.id,e.entry_type AS type,e.character_id AS "characterId",e.dialogue AS text,e.action,
      e.event_text AS "eventText",e.event_type AS "eventType",e.sort_order AS "sortOrder",e.world_sequence AS "worldSequence",e.actor_type AS "actorType",e.event_kind AS "eventKind",e.payload,s.scene_number AS "sceneNumber"
    FROM scene_entries e
    JOIN scenes s ON s.id=e.scene_id
    WHERE e.project_id=$1
    ORDER BY s.scene_number,e.sort_order,e.created_at`, [projectId]);
  return {
    projectId: project.id, sceneId: project.sceneId,
    world: { title: project.title, location: project.location, mood: project.mood, time: project.time, description: project.description, rules: project.rules },
    sceneNumber: project.sceneNumber, sceneSummary: project.sceneSummary, sceneSignal: project.sceneSignal, presentationMode: project.presentationMode,
    publicDirection: project.publicDirection, directorNote: project.publicDirection, turn: project.turn,
    characters: characters.rows.map((character) => ({ ...character, conversation: participants.find((participant) => participant.characterId === character.id) || null })), relationships: relationships.rows,
    participants, conversationSettled: participants.length > 0 && participants.every((participant) => participant.idle), latestSceneSequence,
    logs: entries.rows.map((entry) => entry.type === 'event' ? { id: entry.id, type: 'event', eventType: entry.eventType, text: entry.eventText, sortOrder: entry.sortOrder, sceneNumber: entry.sceneNumber } : entry)
  };
}

export async function buildTurnContext(queryable, projectId, runId) {
  let activeStage = startStage(runId, 'state_load');
  try {
    const state = await getStoryState(queryable, projectId);
    if (!state) { endStage(runId, activeStage, { found: false }); return null; }
    endStage(runId, activeStage, { characters: state.characters.length, publicLogs: state.logs.length, sceneNumber: state.sceneNumber });
    activeStage = startStage(runId, 'speaker_select');
    const character = selectNextSpeaker(state);
    endStage(runId, activeStage, { characterId: character.id, characterName: character.name, strategy: 'round_robin' });
    activeStage = startStage(runId, 'memory_retrieve');
    const memories = (await queryable.query(`SELECT memory_text AS "memoryText",emotion,importance FROM character_memories
      WHERE project_id=$1 AND character_id=$2 ORDER BY importance DESC,created_at DESC LIMIT 6`, [projectId, character.id])).rows;
    endStage(runId, activeStage, { count: memories.length });
    return { state, character, memories, runId };
  } catch (error) {
    failStage(runId, activeStage, error);
    throw error;
  }
}

export async function getActiveParticipants(queryable, projectId) {
  const result = await queryable.query(`SELECT c.id,c.name,c.role,c.gender,c.portrait_url AS "portraitUrl",c.portrait_position AS "portraitPosition",c.emoji,c.color,c.personality,c.speech_style AS "speechStyle",c.goal,c.secret,c.emotion,
    c.active_thread_id AS "activeThreadId",c.model_override AS "modelOverride",COALESCE(c.model_override,p.default_model) AS "effectiveModel",c.current_state AS "currentState",c.last_scanned_event_sequence AS "lastScannedEventSequence",
    sp.idle_at_sequence AS "idleAtSequence",sp.idle_reason AS "idleReason",sp.idle_at AS "idleAt"
    FROM scenes s JOIN scene_participants sp ON sp.scene_id=s.id AND sp.left_sequence IS NULL JOIN characters c ON c.id=sp.character_id JOIN projects p ON p.id=c.project_id
    WHERE s.project_id=$1 AND s.status='active' ORDER BY c.sort_order`, [projectId]);
  return result.rows;
}

export async function buildCharacterContext(queryable, projectId, characterId, runId) {
  const state = await getStoryState(queryable, projectId);
  if (!state) return null;
  const character = (await getActiveParticipants(queryable, projectId)).find((item) => item.id === characterId);
  if (!character) throw new Error('Responder is not an active scene participant.');
  const memories = (await queryable.query(`SELECT memory_text AS "memoryText",emotion,importance FROM character_memories WHERE project_id=$1 AND character_id=$2 ORDER BY importance DESC,created_at DESC LIMIT 6`, [projectId, characterId])).rows;
  const visibleEvents = (await queryable.query(`SELECT e.id,e.entry_type AS type,e.character_id AS "characterId",e.dialogue AS text,e.action,e.event_text AS "eventText",e.event_type AS "eventType",e.sort_order AS "sortOrder",e.world_sequence AS "worldSequence",s.scene_number AS "sceneNumber"
    FROM scene_entries e JOIN scenes s ON s.id=e.scene_id JOIN scene_entry_recipients r ON r.entry_id=e.id
    WHERE e.project_id=$1 AND r.character_id=$2 AND e.world_sequence>COALESCE($3,0) ORDER BY e.world_sequence LIMIT 40`, [projectId, characterId, character.lastScannedEventSequence])).rows;
  return { state, character, memories, visibleEvents, runId };
}

async function nextWorldSequence(client, projectId) {
  const row = (await client.query('UPDATE projects SET next_event_sequence=next_event_sequence+1 WHERE id=$1 RETURNING next_event_sequence-1 AS sequence', [projectId])).rows[0];
  return Number(row.sequence);
}

export async function nextEntryOrder(queryable, sceneId) {
  return Number((await queryable.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM scene_entries WHERE scene_id=$1', [sceneId])).rows[0].next);
}

export async function persistGeneratedTurn(client, context, turn) {
  const { state, character } = context;
  if (!turn.shouldRespond) {
    const sequence = Number((await client.query('SELECT COALESCE(MAX(world_sequence),0) AS sequence FROM scene_entries WHERE scene_id=$1', [state.sceneId])).rows[0].sequence);
    await client.query(`UPDATE scene_participants SET idle_at_sequence=$3,idle_reason=$4,idle_at=NOW()
      WHERE scene_id=$1 AND character_id=$2 AND left_sequence IS NULL`, [state.sceneId, character.id, sequence, turn.silenceReason.slice(0, 300)]);
    await client.query('UPDATE characters SET active_thread_id=$2,last_scanned_event_sequence=$3,pending_operation_step_id=NULL,updated_at=NOW() WHERE id=$1', [character.id, turn.threadId, sequence]);
    await client.query('UPDATE projects SET turn_number=turn_number+1,updated_at=NOW() WHERE id=$1', [state.projectId]);
    return { skipped: true, entryId: null, sequence, silenceReason: turn.silenceReason };
  }
  const entryId = randomUUID();
  const sequence = await nextWorldSequence(client, state.projectId);
  await client.query("UPDATE scene_participants SET idle_at_sequence=NULL,idle_reason='',idle_at=NULL WHERE scene_id=$1 AND left_sequence IS NULL", [state.sceneId]);
  await client.query(`INSERT INTO scene_entries (id,project_id,scene_id,entry_type,character_id,dialogue,action,sort_order,world_sequence,actor_type,event_kind,payload)
    VALUES ($1,$2,$3,'message',$4,$5,$6,$7,$8,'CHARACTER','CHARACTER_RESPONSE',$9)`, [entryId, state.projectId, state.sceneId, character.id, turn.dialogue, turn.action, await nextEntryOrder(client, state.sceneId), sequence, JSON.stringify({ dialogue: turn.dialogue, action: turn.action, emotion: turn.emotion, sceneSignal: turn.sceneSignal })]);
  await client.query(`INSERT INTO scene_entry_recipients(entry_id,character_id) SELECT $1,character_id FROM scene_participants WHERE scene_id=$2 AND left_sequence IS NULL ON CONFLICT DO NOTHING`, [entryId, state.sceneId]);
  await client.query('UPDATE characters SET emotion=$2,active_thread_id=$3,last_scanned_event_sequence=$4,pending_operation_step_id=NULL,updated_at=NOW() WHERE id=$1', [character.id, turn.emotion, turn.threadId, sequence]);
  const validTargets = new Set(state.characters.filter((candidate) => candidate.id !== character.id).map((candidate) => candidate.id));
  for (const change of turn.relationshipChanges.slice(0, 3)) {
    if (!validTargets.has(change.targetId) || !Number.isInteger(change.delta) || change.delta === 0) continue;
    const delta = Math.max(-10, Math.min(10, change.delta));
    const updated = await client.query(`UPDATE relationships SET score=GREATEST(0,LEAST(100,score+$3)),updated_at=NOW()
      WHERE project_id=$1 AND from_character_id=$2 AND to_character_id=$4`, [state.projectId, character.id, delta, change.targetId]);
    if (!updated.rowCount) await client.query('INSERT INTO relationships (id,project_id,from_character_id,to_character_id,label,score) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), state.projectId, character.id, change.targetId, '새롭게 형성되는 관계', Math.max(0, Math.min(100, 50 + delta))]);
  }
  if (turn.memory) await client.query('INSERT INTO character_memories (project_id,character_id,source_entry_id,memory_text,emotion,importance) VALUES ($1,$2,$3,$4,$5,$6)', [state.projectId, character.id, entryId, turn.memory.slice(0, 500), turn.emotion.slice(0, 80), turn.memoryImportance]);
  const publicDirection = publicDirectionForSignal(turn.sceneSignal, character.name);
  const summaryLine = `${character.name}: ${turn.dialogue} / ${turn.action}`;
  await client.query(`UPDATE scenes SET summary=RIGHT(summary || E'\n' || $2,1200),progress_signal=$3,public_direction=$4,updated_at=NOW() WHERE id=$1`, [state.sceneId, summaryLine, turn.sceneSignal, publicDirection]);
  await client.query('UPDATE projects SET turn_number=turn_number+1,public_direction=$2,updated_at=NOW() WHERE id=$1', [state.projectId, publicDirection]);
  return { skipped: false, entryId, sequence };
}

export async function getDirectorContext(queryable, projectId) {
  const state = await getStoryState(queryable, projectId);
  if (!state) return null;
  const director = (await queryable.query(`SELECT active_director_thread_id AS "activeThreadId",last_director_event_sequence AS "lastScannedEventSequence",default_model AS model
    FROM projects WHERE id=$1`, [projectId])).rows[0];
  return { state, ...director };
}

export async function updateDirectorThread(client, projectId, threadId, sequence = null) {
  await client.query(`UPDATE projects SET active_director_thread_id=$2,
    last_director_event_sequence=COALESCE($3,(SELECT COALESCE(MAX(world_sequence),0) FROM scene_entries WHERE project_id=$1)),updated_at=NOW()
    WHERE id=$1`, [projectId, threadId, sequence]);
}

export async function createSceneFromEvent(client, projectId, event, legacyTime = '', legacyType = '일반') {
  const state = await getStoryState(client, projectId);
  if (!state) throw new Error('Project not found.');
  const plan = typeof event === 'string'
    ? { text: event, time: legacyTime, eventType: legacyType, location: state.world.location, mood: state.world.mood, description: `${event} ${state.world.description}`.slice(0, 300) }
    : event;
  const nextSceneNumber = state.sceneNumber + 1;
  const description = (plan.description || `${plan.text} ${state.world.description}`).slice(0, 300);
  const summary = `${state.sceneSummary}\n장면 전환 사건: ${plan.text}`.slice(-1200);
  const sceneId = randomUUID();
  const sceneTime = plan.time || state.world.time;
  const sequence = await nextWorldSequence(client, projectId);
  await client.query("UPDATE scenes SET status='completed',updated_at=NOW() WHERE project_id=$1 AND status='active'", [projectId]);
  await client.query(`INSERT INTO scenes (id,project_id,scene_number,location,mood,scene_time,description,summary,public_direction,private_director_state,presentation_mode)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [sceneId, projectId, nextSceneNumber, plan.location || state.world.location, plan.mood || state.world.mood, sceneTime, description, summary, '새 사건에 대한 각 인물의 서로 다른 반응을 드러내세요.', `Director 장면 전환: ${plan.text}`, state.presentationMode]);
  await client.query(`INSERT INTO scene_participants(scene_id,character_id,joined_sequence)
    SELECT $2,character_id,$3 FROM scene_participants WHERE scene_id=$1 AND left_sequence IS NULL`, [state.sceneId, sceneId, sequence]);
  const entryId = randomUUID();
  await client.query(`INSERT INTO scene_entries (id,project_id,scene_id,entry_type,event_text,event_type,sort_order,world_sequence,actor_type,event_kind,payload)
    VALUES ($1,$2,$3,'event',$4,$5,0,$6,'DIRECTOR','SCENE_TRANSITION',$7)`, [entryId, projectId, sceneId, plan.text, plan.eventType || '시간 전환', sequence, JSON.stringify({ text: plan.text, eventType: plan.eventType || '시간 전환', transition: true })]);
  await client.query(`INSERT INTO scene_entry_recipients(entry_id,character_id)
    SELECT $1,character_id FROM scene_participants WHERE scene_id=$2 AND left_sequence IS NULL`, [entryId, sceneId]);
  await client.query('UPDATE projects SET scene_number=$2,location=$3,mood=$4,description=$5,public_direction=$6,private_director_state=$7,scene_time=$8,updated_at=NOW() WHERE id=$1', [projectId, nextSceneNumber, plan.location || state.world.location, plan.mood || state.world.mood, description, '새 Scene의 사건에 자연스럽게 반응하세요.', `Director 장면 전환: ${plan.text}`, sceneTime]);
  return { entryId, sceneId, sequence };
}

export async function appendSceneEvent(client, projectId, { text, eventType = '일반', actorType = 'DIRECTOR', recipientIds = null }) {
  const state = await getStoryState(client, projectId);
  if (!state) throw new Error('Project not found.');
  const entryId = randomUUID();
  const sequence = await nextWorldSequence(client, projectId);
  await client.query("UPDATE scene_participants SET idle_at_sequence=NULL,idle_reason='',idle_at=NULL WHERE scene_id=$1 AND left_sequence IS NULL", [state.sceneId]);
  await client.query(`INSERT INTO scene_entries (id,project_id,scene_id,entry_type,event_text,event_type,sort_order,world_sequence,actor_type,event_kind,payload)
    VALUES ($1,$2,$3,'event',$4,$5,$6,$7,$8,$9,$10)`, [entryId, projectId, state.sceneId, text, eventType, await nextEntryOrder(client, state.sceneId), sequence, actorType, actorType === 'USER' ? 'USER_MESSAGE' : 'DIRECTOR_EVENT', JSON.stringify({ text, eventType })]);
  const targets = Array.isArray(recipientIds) && recipientIds.length ? recipientIds : (await client.query('SELECT character_id FROM scene_participants WHERE scene_id=$1 AND left_sequence IS NULL', [state.sceneId])).rows.map((row) => row.character_id);
  for (const characterId of targets) await client.query('INSERT INTO scene_entry_recipients(entry_id,character_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [entryId, characterId]);
  return { entryId, sequence };
}

export async function getConversationSettlement(queryable, projectId) {
  const state = await getStoryState(queryable, projectId);
  if (!state) return null;
  return { sceneId: state.sceneId, settled: state.conversationSettled, latestSequence: state.latestSceneSequence, participants: state.participants };
}
