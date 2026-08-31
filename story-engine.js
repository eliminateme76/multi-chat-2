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
  const characters = await queryable.query('SELECT id,name,role,gender,portrait_url AS "portraitUrl",portrait_position AS "portraitPosition",emoji,color,personality,speech_style AS "speechStyle",goal,secret,emotion FROM characters WHERE project_id=$1 ORDER BY sort_order', [projectId]);
  const relationships = await queryable.query('SELECT from_character_id AS "from",to_character_id AS "to",label,score FROM relationships WHERE project_id=$1 ORDER BY created_at', [projectId]);
  const entries = await queryable.query(`SELECT e.id,e.entry_type AS type,e.character_id AS "characterId",e.dialogue AS text,e.action,
      e.event_text AS "eventText",e.event_type AS "eventType",e.sort_order AS "sortOrder",s.scene_number AS "sceneNumber"
    FROM scene_entries e
    JOIN scenes s ON s.id=e.scene_id
    WHERE e.project_id=$1
    ORDER BY s.scene_number,e.sort_order,e.created_at`, [projectId]);
  return {
    projectId: project.id, sceneId: project.sceneId,
    world: { title: project.title, location: project.location, mood: project.mood, time: project.time, description: project.description, rules: project.rules },
    sceneNumber: project.sceneNumber, sceneSummary: project.sceneSummary, sceneSignal: project.sceneSignal, presentationMode: project.presentationMode,
    publicDirection: project.publicDirection, directorNote: project.publicDirection, turn: project.turn,
    characters: characters.rows, relationships: relationships.rows,
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

export async function nextEntryOrder(queryable, sceneId) {
  return Number((await queryable.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM scene_entries WHERE scene_id=$1', [sceneId])).rows[0].next);
}

export async function persistGeneratedTurn(client, context, turn) {
  const { state, character } = context;
  if (!turn.shouldRespond) {
    await client.query('UPDATE projects SET turn_number=turn_number+1,updated_at=NOW() WHERE id=$1', [state.projectId]);
    return { skipped: true };
  }
  const entryId = randomUUID();
  await client.query('INSERT INTO scene_entries (id,project_id,scene_id,entry_type,character_id,dialogue,action,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [entryId, state.projectId, state.sceneId, 'message', character.id, turn.dialogue, turn.action, await nextEntryOrder(client, state.sceneId)]);
  await client.query('UPDATE characters SET emotion=$2,updated_at=NOW() WHERE id=$1', [character.id, turn.emotion]);
  const validTargets = new Set(state.characters.filter((candidate) => candidate.id !== character.id).map((candidate) => candidate.id));
  for (const change of turn.relationshipChanges.slice(0, 3)) {
    if (!validTargets.has(change.targetId) || !Number.isInteger(change.delta) || change.delta === 0) continue;
    const delta = Math.max(-10, Math.min(10, change.delta));
    const updated = await client.query(`UPDATE relationships SET score=GREATEST(0,LEAST(100,score+$3)),updated_at=NOW()
      WHERE project_id=$1 AND ((from_character_id=$2 AND to_character_id=$4) OR (from_character_id=$4 AND to_character_id=$2))`, [state.projectId, character.id, delta, change.targetId]);
    if (!updated.rowCount) await client.query('INSERT INTO relationships (id,project_id,from_character_id,to_character_id,label,score) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), state.projectId, character.id, change.targetId, '새롭게 형성되는 관계', Math.max(0, Math.min(100, 50 + delta))]);
  }
  if (turn.memory) await client.query('INSERT INTO character_memories (project_id,character_id,source_entry_id,memory_text,emotion,importance) VALUES ($1,$2,$3,$4,$5,$6)', [state.projectId, character.id, entryId, turn.memory.slice(0, 500), turn.emotion.slice(0, 80), turn.memoryImportance]);
  const publicDirection = publicDirectionForSignal(turn.sceneSignal, character.name);
  const summaryLine = `${character.name}: ${turn.dialogue} / ${turn.action}`;
  await client.query(`UPDATE scenes SET summary=RIGHT(summary || E'\n' || $2,1200),progress_signal=$3,public_direction=$4,updated_at=NOW() WHERE id=$1`, [state.sceneId, summaryLine, turn.sceneSignal, publicDirection]);
  await client.query('UPDATE projects SET turn_number=turn_number+1,public_direction=$2,updated_at=NOW() WHERE id=$1', [state.projectId, publicDirection]);
  return { skipped: false, entryId };
}

export async function createSceneFromEvent(client, projectId, eventText, nextTime = '', eventType = '일반') {
  const state = await getStoryState(client, projectId);
  if (!state) throw new Error('Project not found.');
  const nextSceneNumber = state.sceneNumber + 1;
  const description = `${eventText} ${state.world.description}`.slice(0, 300);
  const summary = `${state.sceneSummary}\n장면 전환 사건: ${eventText}`.slice(-1200);
  const sceneId = randomUUID();
  const sceneTime = nextTime || state.world.time;
  await client.query("UPDATE scenes SET status='completed',updated_at=NOW() WHERE project_id=$1 AND status='active'", [projectId]);
  await client.query(`INSERT INTO scenes (id,project_id,scene_number,location,mood,scene_time,description,summary,public_direction,private_director_state,presentation_mode)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [sceneId, projectId, nextSceneNumber, state.world.location, state.world.mood, sceneTime, description, summary, '새 사건에 대한 각 인물의 서로 다른 반응을 드러내세요.', `사용자가 투입한 사건: ${eventText}`, state.presentationMode]);
  await client.query('INSERT INTO scene_entries (id,project_id,scene_id,entry_type,event_text,event_type,sort_order) VALUES ($1,$2,$3,$4,$5,$6,0)', [randomUUID(), projectId, sceneId, 'event', eventText, eventType]);
  await client.query('UPDATE projects SET scene_number=$2,description=$3,public_direction=$4,private_director_state=$5,scene_time=$6,updated_at=NOW() WHERE id=$1', [projectId, nextSceneNumber, description, '새 사건에 대한 각 인물의 서로 다른 반응을 드러내세요.', `사용자가 투입한 사건: ${eventText}`, sceneTime]);
}
