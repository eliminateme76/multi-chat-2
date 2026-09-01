import { randomUUID } from 'node:crypto';
import { buildResponderSelectionPrompt } from './context-builder.js';
import { generateCodexTurn, generateResponderSelection } from './codex-client.js';
import { buildCharacterContext, getActiveParticipants, getStoryState, nextEntryOrder, persistGeneratedTurn } from './story-engine.js';
import { failRun, finishRun, startRun } from './runtime-telemetry.js';

const activeProjects = new Set();
const minResponders = (mode) => mode === 'chat' ? 2 : 1;

export async function enqueueProgression(pool, projectId, { mode = 'AUTO', responderIds = [] } = {}) {
  const operationId = randomUUID();
  await pool.query(`INSERT INTO world_operations(id,project_id,type,payload) VALUES ($1,$2,'PROGRESSION',$3)`, [operationId, projectId, JSON.stringify({ mode, responderIds })]);
  void drainProject(pool, projectId);
  return operationId;
}

export async function getOperation(pool, projectId, operationId) {
  return (await pool.query('SELECT id,project_id AS "projectId",type,status,payload,result,error,created_at AS "createdAt",started_at AS "startedAt",completed_at AS "completedAt" FROM world_operations WHERE id=$1 AND project_id=$2', [operationId, projectId])).rows[0];
}

export async function resumeQueuedOperations(pool) {
  const rows = (await pool.query(`SELECT DISTINCT project_id FROM world_operations WHERE status IN ('QUEUED','RUNNING')`)).rows;
  for (const { project_id: projectId } of rows) void drainProject(pool, projectId);
}

export async function drainProject(pool, projectId) {
  if (activeProjects.has(projectId)) return;
  activeProjects.add(projectId);
  try {
    while (true) {
      const operation = (await pool.query(`SELECT id FROM world_operations WHERE project_id=$1 AND status IN ('QUEUED','RUNNING') ORDER BY created_at LIMIT 1`, [projectId])).rows[0];
      if (!operation) break;
      await runProgression(pool, projectId, operation.id);
    }
  } finally { activeProjects.delete(projectId); }
}

async function runProgression(pool, projectId, operationId) {
  const client = await pool.connect();
  const runId = startRun({ type: 'progression', projectId, metadata: { operationId } });
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [projectId]);
    if (!lock.rows[0].locked) return;
    await client.query(`UPDATE world_operations SET status='RUNNING',started_at=COALESCE(started_at,NOW()),error=NULL WHERE id=$1`, [operationId]);
    const operation = await getOperation(client, projectId, operationId);
    const state = await getStoryState(client, projectId);
    const participants = await getActiveParticipants(client, projectId);
    const minimum = minResponders(state.presentationMode);
    if (participants.length < minimum) throw new Error(`${state.presentationMode === 'chat' ? 'CHAT' : 'STORY'} 장면의 참여자가 부족합니다.`);
    let steps = (await client.query(`SELECT id,character_id AS "characterId",step_order AS "stepOrder",status FROM world_operation_steps WHERE operation_id=$1 ORDER BY step_order`, [operationId])).rows;
    if (!steps.length) {
      const requested = operation.payload.mode === 'MANUAL' ? operation.payload.responderIds : null;
      let responderIds = requested;
      if (!responderIds?.length) {
        const selection = await generateResponderSelection(buildResponderSelectionPrompt({ state, participants, minimum }), runId);
        responderIds = selection.responders.map((item) => item.characterId);
      }
      responderIds = [...new Set(responderIds)].filter((id) => participants.some((candidate) => candidate.id === id));
      if (responderIds.length < minimum) throw new Error(`응답자는 최소 ${minimum}명이어야 합니다.`);
      for (const [index, characterId] of responderIds.entries()) await client.query(`INSERT INTO world_operation_steps(operation_id,step_order,character_id) VALUES ($1,$2,$3)`, [operationId, index, characterId]);
      steps = (await client.query(`SELECT id,character_id AS "characterId",step_order AS "stepOrder",status FROM world_operation_steps WHERE operation_id=$1 ORDER BY step_order`, [operationId])).rows;
    }
    for (const step of steps) {
      if (step.status === 'COMPLETED') continue;
      await client.query('BEGIN');
      await client.query(`UPDATE world_operation_steps SET status='RUNNING',error=NULL WHERE id=$1`, [step.id]);
      await client.query(`UPDATE characters SET pending_operation_step_id=$2 WHERE id=$1`, [step.characterId, step.id]);
      await client.query('COMMIT');
      const context = await buildCharacterContext(client, projectId, step.characterId, runId);
      const turn = await generateCodexTurn(context);
      await client.query('BEGIN');
      const outcome = await persistGeneratedTurn(client, context, turn);
      await client.query(`UPDATE world_operation_steps SET status='COMPLETED',thread_id=$2,entry_id=$3,completed_at=NOW() WHERE id=$1`, [step.id, turn.threadId, outcome.entryId]);
      await client.query('COMMIT');
    }
    await client.query(`UPDATE world_operations SET status='COMPLETED',completed_at=NOW(),result=$2 WHERE id=$1`, [operationId, JSON.stringify({ completed: true })]);
    finishRun(runId, { operationId });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    await client.query(`UPDATE world_operations SET status='FAILED',completed_at=NOW(),error=$2 WHERE id=$1`, [operationId, error.message]);
    failRun(runId, error);
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [projectId]); } catch {}
    client.release();
  }
}
