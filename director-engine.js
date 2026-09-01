import { randomUUID } from 'node:crypto';
import { generateDirectorEventApplication, generateDirectorEventSuggestions, generateDirectorSceneTransition } from './codex-client.js';
import { appendSceneEvent, createSceneFromEvent, getDirectorContext, getStoryState, updateDirectorThread } from './story-engine.js';

async function latestSequence(client, projectId) {
  return Number((await client.query('SELECT COALESCE(MAX(world_sequence),0) AS sequence FROM scene_entries WHERE project_id=$1', [projectId])).rows[0].sequence);
}

async function persistDirector(client, projectId, threadId, sequence) {
  await updateDirectorThread(client, projectId, threadId, sequence ?? await latestSequence(client, projectId));
}

export async function listEventSuggestions(queryable, projectId) {
  return (await queryable.query(`SELECT s.id,s.batch_id AS "batchId",s.category,s.text,s.scene_time AS time,s.status,s.created_at AS "createdAt",
      s.source_scene_id AS "sourceSceneId",source.scene_number AS "sourceSceneNumber",
      active.id AS "activeSceneId",(s.source_scene_id<>active.id) AS stale
    FROM event_suggestions s
    JOIN scenes source ON source.id=s.source_scene_id
    JOIN LATERAL (SELECT id FROM scenes WHERE project_id=$1 AND status='active' ORDER BY scene_number DESC LIMIT 1) active ON TRUE
    WHERE s.project_id=$1 AND s.status='AVAILABLE'
    ORDER BY source.scene_number DESC,s.created_at DESC`, [projectId])).rows;
}

export async function createDirectorSuggestions(pool, projectId, desiredTypes, runId) {
  const context = await getDirectorContext(pool, projectId);
  if (!context) throw new Error('Project not found.');
  const result = await generateDirectorEventSuggestions(context.state, runId, desiredTypes, context);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await getDirectorContext(client, projectId);
    if (!current || current.state.sceneId !== context.state.sceneId) throw new Error('Scene changed while event suggestions were generated. Try again.');
    await client.query(`UPDATE event_suggestion_batches SET status='SUPERSEDED'
      WHERE project_id=$1 AND source_scene_id=$2 AND status='ACTIVE'`, [projectId, current.state.sceneId]);
    const batchId = randomUUID();
    const sourceSequence = await latestSequence(client, projectId);
    await client.query(`INSERT INTO event_suggestion_batches(id,project_id,source_scene_id,source_world_sequence)
      VALUES ($1,$2,$3,$4)`, [batchId, projectId, current.state.sceneId, sourceSequence]);
    for (const suggestion of result.suggestions) await client.query(`INSERT INTO event_suggestions(id,batch_id,project_id,source_scene_id,category,text,scene_time)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), batchId, projectId, current.state.sceneId, suggestion.category, suggestion.text, suggestion.time]);
    await persistDirector(client, projectId, result.threadId, sourceSequence);
    await client.query('COMMIT');
    const suggestions = await listEventSuggestions(client, projectId);
    return { batchId, suggestions, generatedSuggestions: suggestions.filter((suggestion) => suggestion.batchId === batchId), threadId: result.threadId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function applyDirectorEvent(pool, projectId, event, runId, suggestionId = null, { automatic = false } = {}) {
  const context = await getDirectorContext(pool, projectId);
  if (!context) throw new Error('Project not found.');
  const source = suggestionId
    ? (await pool.query(`SELECT id,source_scene_id AS "sourceSceneId",category,text,scene_time AS time,status FROM event_suggestions WHERE id=$1 AND project_id=$2`, [suggestionId, projectId])).rows[0]
    : null;
  if (suggestionId && (!source || source.status !== 'AVAILABLE')) throw new Error('This event suggestion is no longer available.');
  const requested = source
    ? { text: source.text, eventType: source.category, time: source.time, forceScene: source.category === '시간 전환', stale: source.sourceSceneId !== context.state.sceneId }
    : { text: event.text, eventType: event.eventType || '일반', time: event.time || '', forceScene: event.eventType === '시간 전환', stale: false };
  if (automatic && requested.eventType === '시간 전환' && !context.state.conversationSettled) {
    throw new Error('자동 시간 전환은 모든 참가자가 현재 대화를 마친 뒤에만 가능합니다.');
  }
  const plan = await generateDirectorEventApplication(context.state, requested, runId, context);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await getDirectorContext(client, projectId);
    if (!current || current.state.sceneId !== context.state.sceneId) throw new Error('Scene changed while the event was being prepared. Try again.');
    const outcome = plan.applyMode === 'CREATE_SCENE'
      ? await createSceneFromEvent(client, projectId, plan)
      : await appendSceneEvent(client, projectId, { text: plan.text, eventType: plan.eventType, actorType: 'DIRECTOR' });
    if (suggestionId) await client.query(`UPDATE event_suggestions SET status='APPLIED',applied_entry_id=$2,applied_scene_id=$3,applied_at=NOW()
      WHERE id=$1`, [suggestionId, outcome.entryId, outcome.sceneId || current.state.sceneId]);
    await persistDirector(client, projectId, plan.threadId, outcome.sequence);
    await client.query('COMMIT');
    return { state: await getStoryState(client, projectId), outcome, plan };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function transitionCompletedScene(client, projectId, runId) {
  const context = await getDirectorContext(client, projectId);
  if (!context || context.state.sceneSignal !== 'complete') return null;
  const plan = await generateDirectorSceneTransition(context.state, runId, context);
  await client.query('BEGIN');
  try {
    const current = await getDirectorContext(client, projectId);
    if (!current || current.state.sceneId !== context.state.sceneId || current.state.sceneSignal !== 'complete') { await client.query('ROLLBACK'); return null; }
    const outcome = await createSceneFromEvent(client, projectId, plan);
    await persistDirector(client, projectId, plan.threadId, outcome.sequence);
    await client.query('COMMIT');
    return outcome;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
