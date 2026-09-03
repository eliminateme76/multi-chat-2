import { randomUUID } from 'node:crypto';
import { generateCodexTurn, generateDirectorProgressionPlan } from './codex-client.js';
import { appendSceneEvent, buildCharacterContext, createSceneFromEvent, getActiveParticipants, getConversationSettlement, getDirectorContext, getStoryState, persistGeneratedTurn, updateDirectorThread } from './story-engine.js';
import { endStage, failRun, failStage, finishRun, startRun, startStage, updateRunMetadata } from './runtime-telemetry.js';
import { cleanStoryState } from './story-dynamics.js';

const activeProjects = new Set();
const minResponders = () => 1;

export async function enqueueProgression(pool, projectId, { mode = 'AUTO', responderIds = [] } = {}) {
  const gate = (await pool.query(`SELECT p.story_state='{}'::jsonb AS "repairNeeded",EXISTS(
    SELECT 1 FROM event_suggestion_batches b JOIN event_suggestions s ON s.batch_id=b.id AND s.status='AVAILABLE'
    WHERE b.project_id=p.id AND b.origin='DIRECTOR_MAJOR' AND b.status='ACTIVE') AS "majorPending"
    FROM projects p WHERE p.id=$1`, [projectId])).rows[0];
  if (!gate) throw new Error('Project not found.');
  if (gate.repairNeeded) throw new Error('이야기 상태 진단을 먼저 확인하고 적용해 주세요.');
  if (gate.majorPending) throw new Error('중대 전개 선택이 대기 중입니다. 전개안을 선택하거나 모두 거절해 주세요.');
  const operationId = randomUUID();
  await pool.query(`INSERT INTO world_operations(id,project_id,type,payload) VALUES ($1,$2,'PROGRESSION',$3)`, [operationId, projectId, JSON.stringify({ mode, responderIds })]);
  void drainProject(pool, projectId);
  return operationId;
}

export async function getOperation(pool, projectId, operationId) {
  const operation = (await pool.query('SELECT id,project_id AS "projectId",type,status,payload,result,error,created_at AS "createdAt",started_at AS "startedAt",completed_at AS "completedAt" FROM world_operations WHERE id=$1 AND project_id=$2', [operationId, projectId])).rows[0];
  if (!operation) return null;
  operation.steps = (await pool.query(`SELECT s.id,s.character_id AS "characterId",c.name AS "characterName",s.step_order AS "stepOrder",s.status,
      s.thread_id AS "threadId",s.created_at AS "createdAt",s.completed_at AS "completedAt"
    FROM world_operation_steps s JOIN characters c ON c.id=s.character_id
    WHERE s.operation_id=$1 ORDER BY s.step_order`, [operationId])).rows;
  return operation;
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
    let state = await getStoryState(client, projectId);
    let participants = await getActiveParticipants(client, projectId);
    let directorAction = null;
    const minimum = minResponders(state.presentationMode);
    if (participants.length < minimum) throw new Error(`${state.presentationMode === 'chat' ? 'CHAT' : 'STORY'} 장면의 참여자가 부족합니다.`);
    let steps = (await client.query(`SELECT id,character_id AS "characterId",step_order AS "stepOrder",status FROM world_operation_steps WHERE operation_id=$1 ORDER BY step_order`, [operationId])).rows;
    if (!steps.length) {
      const requested = operation.payload.mode === 'MANUAL' ? operation.payload.responderIds : null;
      let responderIds = requested;
      const latestSequence = state.latestSceneSequence;
      const cadence = { gentle: 8, balanced: 5, high: 3 }[state.dramaIntensity] || 5;
      const needsChatPlan = state.sceneSignal !== 'continue' || latestSequence - Number(state.storyState.lastDirectorSequence || 0) >= cadence;
      if (!responderIds?.length && (state.presentationMode === 'scene' || needsChatPlan)) {
        const director = await getDirectorContext(client, projectId);
        const tensionBefore = Number(state.storyState?.tension || 0);
        const directorStage = startStage(runId, 'director_plan', { intensity: state.dramaIntensity, tension: tensionBefore });
        let plan;
        try {
          plan = await generateDirectorProgressionPlan(state, participants, runId, director);
          endStage(runId, directorStage, { action: plan.action, responders: plan.responders.map((item) => item.characterId) });
        } catch (error) {
          failStage(runId, directorStage, error);
          throw error;
        }
        directorAction = plan.action;
        const currentIds = new Set(participants.map((item) => item.id));
        const nextIds = plan.action === 'TRANSITION_SCENE' ? new Set(plan.nextScene.participantIds.filter((id) => state.characters.some((item) => item.id === id))) : currentIds;
        responderIds = [...new Set(plan.responders.map((item) => item.characterId))].filter((id) => nextIds.has(id));
        if (!responderIds.length) throw new Error('World Director가 현재 참여자 중 응답자를 선택하지 못했습니다.');
        await client.query('BEGIN');
        let actionOutcome = null;
        if (plan.action === 'PROPOSE_MAJOR') {
          const batchId = randomUUID();
          await client.query(`UPDATE event_suggestion_batches SET status='SUPERSEDED' WHERE project_id=$1 AND origin='DIRECTOR_MAJOR' AND status='ACTIVE'`, [projectId]);
          await client.query(`INSERT INTO event_suggestion_batches(id,project_id,source_scene_id,source_world_sequence,origin) VALUES ($1,$2,$3,$4,'DIRECTOR_MAJOR')`, [batchId, projectId, state.sceneId, state.latestSceneSequence]);
          for (const proposal of plan.majorProposals) await client.query(`INSERT INTO event_suggestions(id,batch_id,project_id,source_scene_id,category,text,scene_time,severity,consequence,requires_approval)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'MAJOR',$8,TRUE)`, [randomUUID(), batchId, projectId, state.sceneId, proposal.category, proposal.text, proposal.time, proposal.consequence]);
          const nextStoryState = cleanStoryState({ ...plan.storyState, lastDirectorSequence: state.latestSceneSequence }, state.characters.map((item) => item.id), state.storyState);
          await client.query('UPDATE projects SET story_state=$2,active_director_thread_id=$3,last_director_event_sequence=$4,updated_at=NOW() WHERE id=$1', [projectId, JSON.stringify(nextStoryState), plan.threadId, state.latestSceneSequence]);
          await client.query('UPDATE scenes SET dramatic_state=$2,updated_at=NOW() WHERE id=$1', [state.sceneId, JSON.stringify(plan.sceneState)]);
          await client.query(`UPDATE world_operations SET status='COMPLETED',completed_at=NOW(),result=$2 WHERE id=$1`, [operationId, JSON.stringify({ completed: true, awaitingDecision: true, majorBatchId: batchId, responders: [], messagesCreated: 0 })]);
          await client.query('COMMIT');
          updateRunMetadata(runId, { directorAction: plan.action, tensionBefore: state.storyState.tension, tensionAfter: nextStoryState.tension, majorBatchId: batchId });
          finishRun(runId, { operationId, directorAction: plan.action, awaitingDecision: true, messagesCreated: 0 });
          return;
        }
        if (plan.action === 'INJECT_MINOR_EVENT') actionOutcome = await appendSceneEvent(client, projectId, { text: plan.eventPlan.text, eventType: plan.eventPlan.eventType, actorType: 'DIRECTOR' });
        if (plan.action === 'TRANSITION_SCENE') actionOutcome = await createSceneFromEvent(client, projectId, { ...plan.nextScene, dramaticState: plan.sceneState });
        state = await getStoryState(client, projectId);
        participants = await getActiveParticipants(client, projectId);
        const planSequence = actionOutcome?.sequence || state.latestSceneSequence;
        const nextStoryState = cleanStoryState({ ...plan.storyState, lastDirectorSequence: planSequence }, state.characters.map((item) => item.id), state.storyState);
        await client.query('UPDATE projects SET story_state=$2,active_director_thread_id=$3,last_director_event_sequence=$4,updated_at=NOW() WHERE id=$1', [projectId, JSON.stringify(nextStoryState), plan.threadId, planSequence]);
        await client.query('UPDATE scenes SET dramatic_state=$2,public_direction=COALESCE(NULLIF($3,\'\'),public_direction),updated_at=NOW() WHERE id=$1', [state.sceneId, JSON.stringify(plan.sceneState), plan.sceneState.objective]);
        await client.query('COMMIT');
        state = await getStoryState(client, projectId);
        participants = await getActiveParticipants(client, projectId);
        updateRunMetadata(runId, { directorAction: plan.action, tensionBefore, tensionAfter: nextStoryState.tension, participantCount: participants.length });
      } else if (!responderIds?.length) {
        responderIds = participants.map((participant) => participant.id);
      }
      responderIds = [...new Set(responderIds)].filter((id) => participants.some((candidate) => candidate.id === id));
      if (responderIds.length < minimum) throw new Error(`응답자는 최소 ${minimum}명이어야 합니다.`);
      for (const [index, characterId] of responderIds.entries()) await client.query(`INSERT INTO world_operation_steps(operation_id,step_order,character_id) VALUES ($1,$2,$3)`, [operationId, index, characterId]);
      steps = (await client.query(`SELECT id,character_id AS "characterId",step_order AS "stepOrder",status FROM world_operation_steps WHERE operation_id=$1 ORDER BY step_order`, [operationId])).rows;
    }
    const responders = [];
    const silentParticipants = [];
    let messagesCreated = 0;
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
      if (outcome.skipped) silentParticipants.push({ characterId: step.characterId, reason: outcome.silenceReason });
      else { responders.push(step.characterId); messagesCreated += 1; }
    }
    const settlement = await getConversationSettlement(client, projectId);
    if (state.presentationMode === 'chat' && settlement.settled) await client.query("UPDATE scenes SET progress_signal='complete',public_direction='모든 참가자가 현재 대화를 마쳤습니다. 새 사건을 기다립니다.',updated_at=NOW() WHERE project_id=$1 AND status='active'", [projectId]);
    const result = { completed: true, transition: null, directorAction, responders, silentParticipants, conversationSettled: settlement.settled, messagesCreated };
    await client.query(`UPDATE world_operations SET status='COMPLETED',completed_at=NOW(),result=$2 WHERE id=$1`, [operationId, JSON.stringify(result)]);
    finishRun(runId, { operationId, directorAction, sceneTransitioned: directorAction === 'TRANSITION_SCENE', conversationSettled: settlement.settled, messagesCreated });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    await client.query(`UPDATE world_operation_steps SET status='FAILED',error=$2,completed_at=NOW() WHERE operation_id=$1 AND status IN ('QUEUED','RUNNING')`, [operationId, error.message]);
    await client.query(`UPDATE characters SET pending_operation_step_id=NULL,updated_at=NOW() WHERE project_id=$1 AND pending_operation_step_id IN (SELECT id FROM world_operation_steps WHERE operation_id=$2)`, [projectId, operationId]);
    await client.query(`UPDATE world_operations SET status='FAILED',completed_at=NOW(),error=$2 WHERE id=$1`, [operationId, error.message]);
    failRun(runId, error);
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [projectId]); } catch {}
    client.release();
  }
}
