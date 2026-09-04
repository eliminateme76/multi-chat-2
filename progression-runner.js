import { randomUUID } from 'node:crypto';
import { cleanupCodexThread } from './codex-client.js';
import { concordiaEngineInfo, generateConcordiaDirectorPlan, generateConcordiaTurn } from './concordia-client.js';
import { appendSceneEvent, buildCharacterContext, consumePlannedResponder, createSceneFromEvent, getActiveParticipants, getConversationSettlement, getDirectorContext, getStoryState, persistGeneratedTurn, updateDirectorThread } from './story-engine.js';
import { failRun, finishRun, startRun, updateRunMetadata } from './runtime-telemetry.js';
import { cleanDramaticState, cleanStoryState } from './story-dynamics.js';

const activeProjects = new Set();
const minResponders = () => 1;
const engineInfo = concordiaEngineInfo();

const publicDirectorPlan = (operationId, plan, responderIds, remainingResponderIds = responderIds, responsesConsumed = 0, reused = false) => ({
  sourceOperationId: operationId,
  action: plan.action,
  rationale: String(plan.rationale || '').trim().slice(0, 500),
  responderIds,
  remainingResponderIds,
  responsesConsumed,
  reused
});

async function applyPostCharacterJudgment(client, projectId, operationId, plan, characterOutcome) {
  let state = await getStoryState(client, projectId);
  let participants = await getActiveParticipants(client, projectId);
  const characterIds = state.characters.map((item) => item.id);
  const currentIds = new Set(participants.map((item) => item.id));
  const protectedTargetId = characterOutcome?.actionScope === 'CHARACTER_ATTEMPT' ? characterOutcome.actionTargetId : null;
  let responderIds;
  if (protectedTargetId) {
    if (!['CONTINUE','INJECT_MINOR_EVENT'].includes(plan.action)) throw new Error('character attempt requires the target response before scene transition or major proposal');
    if (!currentIds.has(protectedTargetId)) throw new Error('character attempt target is no longer active');
    responderIds = [protectedTargetId];
  } else {
    const allowed = plan.action === 'TRANSITION_SCENE'
      ? new Set(plan.nextScene.participantIds.filter((id) => characterIds.includes(id)))
      : currentIds;
    responderIds = [...new Set(plan.responders.map((item) => item.characterId))].filter((id) => allowed.has(id));
  }
  if (!responderIds.length) throw new Error('World Director가 다음 응답자를 선택하지 못했습니다.');

  await client.query('BEGIN');
  try {
    let actionOutcome = null;
    let majorBatchId = null;
    if (plan.action === 'PROPOSE_MAJOR') {
      majorBatchId = randomUUID();
      await client.query(`UPDATE event_suggestion_batches SET status='SUPERSEDED' WHERE project_id=$1 AND origin='DIRECTOR_MAJOR' AND status='ACTIVE'`, [projectId]);
      await client.query(`INSERT INTO event_suggestion_batches(id,project_id,source_scene_id,source_world_sequence,origin) VALUES ($1,$2,$3,$4,'DIRECTOR_MAJOR')`, [majorBatchId, projectId, state.sceneId, state.latestSceneSequence]);
      for (const proposal of plan.majorProposals) await client.query(`INSERT INTO event_suggestions(id,batch_id,project_id,source_scene_id,category,text,scene_time,severity,consequence,requires_approval)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'MAJOR',$8,TRUE)`, [randomUUID(), majorBatchId, projectId, state.sceneId, proposal.category, proposal.text, proposal.time, proposal.consequence]);
    }
    if (plan.action === 'INJECT_MINOR_EVENT') actionOutcome = await appendSceneEvent(client, projectId, { text: plan.eventPlan.text, eventType: plan.eventPlan.eventType, actorType: 'DIRECTOR' });
    if (plan.action === 'TRANSITION_SCENE') actionOutcome = await createSceneFromEvent(client, projectId, { ...plan.nextScene, dramaticState: plan.sceneState });

    state = await getStoryState(client, projectId);
    participants = await getActiveParticipants(client, projectId);
    const planSequence = actionOutcome?.sequence || state.latestSceneSequence;
    const nextStoryState = cleanStoryState({ ...plan.storyState, lastDirectorSequence: planSequence }, state.characters.map((item) => item.id), state.storyState);
    const queuedIds = majorBatchId ? [] : responderIds.slice(0, 2);
    const nextSceneState = cleanDramaticState({
      ...plan.sceneState,
      plannedResponderIds: queuedIds,
      planResponderIds: responderIds.slice(0, 2),
      planStartedSequence: planSequence,
      responsesConsumed: 0,
      planAction: plan.action,
      planRationale: plan.rationale,
      planOperationId: operationId
    }, state.characters.map((item) => item.id), state.dramaticState);
    const directorPlan = publicDirectorPlan(operationId, plan, responderIds.slice(0, 2), queuedIds);
    const judgment = {
      action: plan.action,
      directorPlan,
      awaitingDecision: Boolean(majorBatchId),
      majorBatchId,
      worldPhase: plan.worldResolution.phase,
      worldOutcome: plan.worldResolution.outcome,
      tensionDirection: plan.worldResolution.tensionDirection,
      runtime: { timeToFirstTokenMs: plan.timeToFirstTokenMs, contextTokens: Number(plan.threadUsage?.last?.inputTokens || 0), outputTokens: Number(plan.threadUsage?.last?.outputTokens || 0), threadRolledOver: plan.threadRolledOver },
      engine: engineInfo
    };
    await client.query('UPDATE projects SET story_state=$2,updated_at=NOW() WHERE id=$1', [projectId, JSON.stringify(nextStoryState)]);
    await updateDirectorThread(client, projectId, plan, planSequence);
    await client.query('UPDATE scenes SET dramatic_state=$2,public_direction=COALESCE(NULLIF($3,\'\'),public_direction),progress_signal=$4,updated_at=NOW() WHERE id=$1', [state.sceneId, JSON.stringify(nextSceneState), nextSceneState.objective, majorBatchId ? 'stalled' : 'continue']);
    await client.query(`UPDATE world_operations SET payload=payload || $2::jsonb WHERE id=$1`, [operationId, JSON.stringify({ concordiaStage: 'GM_COMPLETED', postCharacterJudgment: judgment, simulationEngine: engineInfo.name, simulationEngineVersion: engineInfo.version })]);
    await client.query('COMMIT');
    await cleanupCodexThread(plan.previousThreadId);
    return { judgment, planState: nextSceneState, storyState: nextStoryState, participants };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function enqueueProgression(pool, projectId, { mode = 'AUTO', responderIds = [] } = {}) {
  const gate = (await pool.query(`SELECT p.story_state='{}'::jsonb AND EXISTS(
    SELECT 1 FROM scene_entries e WHERE e.project_id=p.id) AS "repairNeeded",EXISTS(
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

export async function retryProgression(pool, projectId, operationId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [projectId]);
    const operation = (await client.query(`SELECT id,status,type FROM world_operations WHERE id=$1 AND project_id=$2 FOR UPDATE`, [operationId, projectId])).rows[0];
    if (!operation) throw new Error('Operation not found.');
    if (operation.type !== 'PROGRESSION') throw new Error('진행 작업만 재시도할 수 있습니다.');
    if (operation.status !== 'FAILED') throw new Error('실패한 진행 작업만 재시도할 수 있습니다.');
    const stepCounts = (await client.query(`SELECT COUNT(*) AS total,COUNT(*) FILTER (WHERE status='FAILED') AS failed FROM world_operation_steps WHERE operation_id=$1`, [operationId])).rows[0];
    const failedSteps = Number(stepCounts.failed);
    const retryState = (await client.query('SELECT payload FROM world_operations WHERE id=$1', [operationId])).rows[0]?.payload || {};
    if (Number(stepCounts.total) > 0 && !failedSteps && !['GM_PENDING','GM_COMPLETED'].includes(retryState.concordiaStage)) throw new Error('재시도할 실패 단계가 없습니다.');
    await client.query(`UPDATE world_operation_steps SET status='QUEUED',error=NULL,completed_at=NULL WHERE operation_id=$1 AND status='FAILED'`, [operationId]);
    await client.query(`UPDATE world_operations SET status='QUEUED',result='{}'::jsonb,error=NULL,started_at=NULL,completed_at=NULL WHERE id=$1`, [operationId]);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
  void drainProject(pool, projectId);
  return operationId;
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
  const runId = startRun({ type: 'progression', projectId, metadata: { operationId, simulationEngine: engineInfo.name, simulationEngineVersion: engineInfo.version } });
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [projectId]);
    if (!lock.rows[0].locked) return;
    await client.query(`UPDATE world_operations SET status='RUNNING',started_at=COALESCE(started_at,NOW()),error=NULL WHERE id=$1`, [operationId]);
    const operation = await getOperation(client, projectId, operationId);
    let state = await getStoryState(client, projectId);
    let participants = await getActiveParticipants(client, projectId);
    let directorAction = operation.payload.directorAction || null;
    let planReused = false;
    let directorRuntime = null;
    let latestPlanState = state.dramaticState;
    const minimum = minResponders(state.presentationMode);
    if (participants.length < minimum) throw new Error(`${state.presentationMode === 'chat' ? 'CHAT' : 'STORY'} 장면의 참여자가 부족합니다.`);
    let steps = (await client.query(`SELECT id,character_id AS "characterId",step_order AS "stepOrder",status FROM world_operation_steps WHERE operation_id=$1 ORDER BY step_order`, [operationId])).rows;
    if (!steps.length) {
      const requested = operation.payload.mode === 'MANUAL' ? operation.payload.responderIds : null;
      let responderIds = operation.payload.directorPlanned && Array.isArray(operation.payload.plannedResponderIds) ? operation.payload.plannedResponderIds : requested;
      const queuedResponders = state.dramaticState?.plannedResponderIds || [];
      const plannedAt = Number(state.dramaticState?.planStartedSequence || 0);
      const planInvalidated = state.logs.some((entry) => entry.type === 'event' && Number(entry.worldSequence || 0) > plannedAt);
      const reusableResponder = operation.payload.mode === 'AUTO' && state.sceneSignal === 'continue' && Number(state.dramaticState?.responsesConsumed || 0) < 2 && !planInvalidated
        ? queuedResponders.find((id) => participants.some((candidate) => candidate.id === id))
        : null;
      if (!responderIds?.length && reusableResponder) {
        responderIds = [reusableResponder];
        planReused = true;
        directorAction = 'REUSE_PLAN';
        await client.query(`UPDATE world_operations SET payload=payload || $2::jsonb WHERE id=$1`, [operationId, JSON.stringify({
          directorPlanned: true, planReused: true, plannedResponderIds: responderIds,
          directorPlan: { sourceOperationId: state.dramaticState.planOperationId || null, action: state.dramaticState.planAction || null, rationale: state.dramaticState.planRationale || '', responderIds: state.dramaticState.planResponderIds || responderIds, reused: true }
        })]);
      }
      const latestSequence = state.latestSceneSequence;
      const cadence = { gentle: 8, balanced: 5, high: 3 }[state.dramaIntensity] || 5;
      const needsChatPlan = state.sceneSignal !== 'continue' || latestSequence - Number(state.storyState.lastDirectorSequence || 0) >= cadence;
      if (!planReused && !operation.payload.directorPlanned && !responderIds?.length && (state.presentationMode === 'scene' || needsChatPlan)) {
        const director = await getDirectorContext(client, projectId);
        const tensionBefore = Number(state.storyState?.tension || 0);
        let plan;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            const correction = attempt === 2 ? '직전 출력은 미판정 WORLD_ATTEMPT가 있는데 CONTINUE를 선택해 거부되었습니다. 캐릭터의 시도와 타인의 선택을 대신하지 않으면서, INJECT_MINOR_EVENT로 환경이 확정할 수 있는 결과만 사건화하거나 필요한 다른 허용 action을 선택하세요.' : '';
            plan = await generateConcordiaDirectorPlan(state, participants, runId, director, correction);
            break;
          } catch (error) {
            if (attempt === 2 || !/pending world attempt must be resolved/i.test(error.message)) throw error;
            updateRunMetadata(runId, { directorRetry: attempt, retryReason: error.message, activePhase: '세계 행동 재판정' });
          }
        }
        directorRuntime = plan;
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
          const stoppedPlanState = cleanDramaticState({ ...plan.sceneState, plannedResponderIds: [], planResponderIds: responderIds, planStartedSequence: state.latestSceneSequence, responsesConsumed: 0, planAction: plan.action, planRationale: plan.rationale, planOperationId: operationId }, state.characters.map((item) => item.id), state.dramaticState);
          await client.query('UPDATE projects SET story_state=$2,updated_at=NOW() WHERE id=$1', [projectId, JSON.stringify(nextStoryState)]);
          await updateDirectorThread(client, projectId, plan, state.latestSceneSequence);
          await client.query('UPDATE scenes SET dramatic_state=$2,updated_at=NOW() WHERE id=$1', [state.sceneId, JSON.stringify(stoppedPlanState)]);
          const directorPlan = { sourceOperationId: operationId, action: plan.action, rationale: String(plan.rationale || '').trim().slice(0, 500), responderIds, remainingResponderIds: [], responsesConsumed: 0, reused: false };
          await client.query(`UPDATE world_operations SET payload=payload || $3::jsonb,status='COMPLETED',completed_at=NOW(),result=$2 WHERE id=$1`, [operationId, JSON.stringify({ completed: true, awaitingDecision: true, majorBatchId: batchId, directorAction: plan.action, directorPlan, worldPhase: plan.worldResolution.phase, worldOutcome: plan.worldResolution.outcome, tensionDirection: plan.worldResolution.tensionDirection, responders: [], messagesCreated: 0, engine: engineInfo }), JSON.stringify({ directorPlanned: true, directorPlan, concordiaStage: 'GM_COMPLETED', simulationEngine: engineInfo.name, simulationEngineVersion: engineInfo.version })]);
          await client.query('COMMIT');
          await cleanupCodexThread(plan.previousThreadId);
          updateRunMetadata(runId, { directorAction: plan.action, worldPhase: plan.worldResolution.phase, worldOutcome: plan.worldResolution.outcome, tensionDirection: plan.worldResolution.tensionDirection, tensionBefore: state.storyState.tension, tensionAfter: nextStoryState.tension, majorBatchId: batchId });
          finishRun(runId, { operationId, directorAction: plan.action, awaitingDecision: true, messagesCreated: 0 });
          return;
        }
        if (plan.action === 'INJECT_MINOR_EVENT') actionOutcome = await appendSceneEvent(client, projectId, { text: plan.eventPlan.text, eventType: plan.eventPlan.eventType, actorType: 'DIRECTOR' });
        if (plan.action === 'TRANSITION_SCENE') actionOutcome = await createSceneFromEvent(client, projectId, { ...plan.nextScene, dramaticState: plan.sceneState });
        state = await getStoryState(client, projectId);
        participants = await getActiveParticipants(client, projectId);
        const planSequence = actionOutcome?.sequence || state.latestSceneSequence;
        const nextStoryState = cleanStoryState({ ...plan.storyState, lastDirectorSequence: planSequence }, state.characters.map((item) => item.id), state.storyState);
        const queuedSceneState = cleanDramaticState({ ...plan.sceneState, plannedResponderIds: responderIds.slice(0, 2), planResponderIds: responderIds.slice(0, 2), planStartedSequence: planSequence, responsesConsumed: 0, planAction: plan.action, planRationale: plan.rationale, planOperationId: operationId }, state.characters.map((item) => item.id), state.dramaticState);
        await client.query('UPDATE projects SET story_state=$2,updated_at=NOW() WHERE id=$1', [projectId, JSON.stringify(nextStoryState)]);
        await updateDirectorThread(client, projectId, plan, planSequence);
        await client.query('UPDATE scenes SET dramatic_state=$2,public_direction=COALESCE(NULLIF($3,\'\'),public_direction),updated_at=NOW() WHERE id=$1', [state.sceneId, JSON.stringify(queuedSceneState), queuedSceneState.objective]);
        await client.query(`UPDATE world_operations SET payload=payload || $2::jsonb WHERE id=$1`, [operationId, JSON.stringify({ directorPlanned: true, directorAction: plan.action, plannedResponderIds: responderIds, worldPhase: plan.worldResolution.phase, worldOutcome: plan.worldResolution.outcome, tensionDirection: plan.worldResolution.tensionDirection, directorPlan: { sourceOperationId: operationId, action: plan.action, rationale: String(plan.rationale || '').trim().slice(0, 500), responderIds, reused: false } })]);
        await client.query('COMMIT');
        await cleanupCodexThread(plan.previousThreadId);
        state = await getStoryState(client, projectId);
        latestPlanState = state.dramaticState;
        participants = await getActiveParticipants(client, projectId);
        updateRunMetadata(runId, { directorAction: plan.action, worldPhase: plan.worldResolution.phase, worldOutcome: plan.worldResolution.outcome, tensionDirection: plan.worldResolution.tensionDirection, tensionBefore, tensionAfter: nextStoryState.tension, participantCount: participants.length });
      } else if (!responderIds?.length) {
        responderIds = [participants[Math.abs(Number(state.turn || 0)) % participants.length].id];
      }
      responderIds = [...new Set(responderIds)].filter((id) => participants.some((candidate) => candidate.id === id));
      if (responderIds.length < minimum) throw new Error(`응답자는 최소 ${minimum}명이어야 합니다.`);
      await client.query('BEGIN');
      if (operation.payload.mode === 'MANUAL' && state.dramaticState?.plannedResponderIds?.length) {
        const clearedPlan = cleanDramaticState({ ...state.dramaticState, plannedResponderIds: [], responsesConsumed: 0 }, state.characters.map((item) => item.id), state.dramaticState);
        await client.query('UPDATE scenes SET dramatic_state=$2,updated_at=NOW() WHERE id=$1', [state.sceneId, JSON.stringify(clearedPlan)]);
      }
      for (const [index, characterId] of responderIds.slice(0, 1).entries()) await client.query(`INSERT INTO world_operation_steps(operation_id,step_order,character_id) VALUES ($1,$2,$3)`, [operationId, index, characterId]);
      await client.query('COMMIT');
      steps = (await client.query(`SELECT id,character_id AS "characterId",step_order AS "stepOrder",status FROM world_operation_steps WHERE operation_id=$1 ORDER BY step_order`, [operationId])).rows;
    }
    const persistedCharacterOutcome = operation.payload.characterOutcome || null;
    const responders = persistedCharacterOutcome && !persistedCharacterOutcome.skipped ? [persistedCharacterOutcome.characterId] : [];
    const silentParticipants = persistedCharacterOutcome?.skipped ? [{ characterId: persistedCharacterOutcome.characterId, reason: persistedCharacterOutcome.silenceReason }] : [];
    const characterRuntime = persistedCharacterOutcome?.runtime ? [persistedCharacterOutcome.runtime] : [];
    let messagesCreated = persistedCharacterOutcome && !persistedCharacterOutcome.skipped ? 1 : 0;
    for (const step of steps) {
      if (step.status === 'COMPLETED') continue;
      await client.query('BEGIN');
      await client.query(`UPDATE world_operation_steps SET status='RUNNING',error=NULL WHERE id=$1`, [step.id]);
      await client.query(`UPDATE characters SET pending_operation_step_id=$2 WHERE id=$1`, [step.characterId, step.id]);
      await client.query('COMMIT');
      const context = await buildCharacterContext(client, projectId, step.characterId, runId);
      let turn;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          turn = await generateConcordiaTurn(context);
          break;
        } catch (error) {
          const transient = /timed out|app-server (?:is not available|exited unexpectedly|stopped)/i.test(error.message);
          if (attempt === 2 || !transient) throw error;
          updateRunMetadata(runId, { characterRetry: attempt, retryReason: error.message, activePhase: '캐릭터 응답 재시도' });
        }
      }
      await client.query('BEGIN');
      const outcome = await persistGeneratedTurn(client, context, turn);
      latestPlanState = await consumePlannedResponder(client, context, turn);
      await client.query(`UPDATE world_operation_steps SET status='COMPLETED',thread_id=$2,entry_id=$3,completed_at=NOW() WHERE id=$1`, [step.id, turn.threadId, outcome.entryId]);
      const storedRuntime = { characterId: step.characterId, timeToFirstTokenMs: turn.timeToFirstTokenMs, contextTokens: Number(turn.threadUsage?.last?.inputTokens || 0), outputTokens: Number(turn.threadUsage?.last?.outputTokens || 0), threadRolledOver: turn.threadRolledOver };
      await client.query(`UPDATE world_operations SET payload=payload || $2::jsonb WHERE id=$1`, [operationId, JSON.stringify({
        concordiaStage: 'GM_PENDING', simulationEngine: engineInfo.name, simulationEngineVersion: engineInfo.version,
        characterOutcome: { characterId: step.characterId, entryId: outcome.entryId, skipped: outcome.skipped, silenceReason: outcome.silenceReason || '', actionScope: turn.actionScope, actionTargetId: turn.actionTargetId, sceneSignal: turn.sceneSignal, runtime: storedRuntime }
      })]);
      await client.query('COMMIT');
      await cleanupCodexThread(turn.previousThreadId);
      characterRuntime.push(storedRuntime);
      if (outcome.skipped) silentParticipants.push({ characterId: step.characterId, reason: outcome.silenceReason });
      else { responders.push(step.characterId); messagesCreated += 1; }
    }
    let currentOperation = await getOperation(client, projectId, operationId);
    let postJudgment = currentOperation.payload.postCharacterJudgment || null;
    if (currentOperation.payload.concordiaStage !== 'GM_COMPLETED') {
      state = await getStoryState(client, projectId);
      participants = await getActiveParticipants(client, projectId);
      const characterOutcome = currentOperation.payload.characterOutcome;
      if (!characterOutcome) throw new Error('Concordia GM 판정에 필요한 캐릭터 결과가 없습니다.');
      const director = await getDirectorContext(client, projectId);
      const targetInstruction = characterOutcome.actionScope === 'CHARACTER_ATTEMPT'
        ? `방금 행동은 다른 캐릭터(${characterOutcome.actionTargetId})의 선택을 기다린다. 수락·거절이나 감정·행동을 대신 정하지 말고, 독립적인 외부 변화가 꼭 필요한 경우에만 세계 action을 사용하라. 어떤 action이든 해당 캐릭터를 다음 응답자로 지정하라.`
        : '이 호출은 방금 저장된 캐릭터 행동 직후의 세계 판정이다. 환경·우연·세계 규칙의 결과만 확정하고 다음 반응 기회를 정하라.';
      let judgmentPlan;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const correction = attempt === 1 ? targetInstruction : `${targetInstruction} 직전 출력은 권한 경계를 어겼다. 미판정 WORLD_ATTEMPT는 환경 사건으로 반드시 해결하고, CHARACTER_ATTEMPT 중에는 장면 전환이나 중대 제안을 하지 마라.`;
          judgmentPlan = await generateConcordiaDirectorPlan(state, participants, runId, director, correction);
          if (characterOutcome.actionScope === 'CHARACTER_ATTEMPT' && !['CONTINUE','INJECT_MINOR_EVENT'].includes(judgmentPlan.action)) throw new Error('character attempt requires the target response before scene transition or major proposal');
          break;
        } catch (error) {
          if (attempt === 2 || !/pending world attempt|character attempt requires/i.test(error.message)) throw error;
          updateRunMetadata(runId, { directorRetry: attempt, retryReason: error.message, activePhase: 'Concordia 세계 행동 재판정' });
        }
      }
      const applied = await applyPostCharacterJudgment(client, projectId, operationId, judgmentPlan, characterOutcome);
      postJudgment = applied.judgment;
      latestPlanState = applied.planState;
      directorRuntime = judgmentPlan;
      directorAction = judgmentPlan.action;
      updateRunMetadata(runId, { directorAction: judgmentPlan.action, worldPhase: postJudgment.worldPhase, worldOutcome: postJudgment.worldOutcome, tensionDirection: postJudgment.tensionDirection, awaitingDecision: postJudgment.awaitingDecision });
    } else {
      state = await getStoryState(client, projectId);
      latestPlanState = state.dramaticState;
      directorAction = postJudgment?.action || directorAction;
    }
    const settlement = await getConversationSettlement(client, projectId);
    if (state.presentationMode === 'chat' && settlement.settled && !postJudgment?.awaitingDecision) await client.query("UPDATE scenes SET progress_signal='complete',public_direction='모든 참가자가 현재 대화를 마쳤습니다. 새 사건을 기다립니다.',updated_at=NOW() WHERE project_id=$1 AND status='active'", [projectId]);
    const planResponderIds = latestPlanState?.planResponderIds || [];
    const directorPlan = postJudgment?.directorPlan || ((directorRuntime || planReused) && latestPlanState?.planRationale ? { sourceOperationId: latestPlanState.planOperationId || null, action: latestPlanState.planAction || null, rationale: latestPlanState.planRationale, responderIds: planResponderIds, remainingResponderIds: latestPlanState.plannedResponderIds || [], responsesConsumed: Number(latestPlanState.responsesConsumed || 0), reused: planReused } : null);
    const result = { completed: true, transition: directorAction === 'TRANSITION_SCENE' ? true : null, awaitingDecision: Boolean(postJudgment?.awaitingDecision), majorBatchId: postJudgment?.majorBatchId || null, directorAction, directorPlan, planReused, worldPhase: postJudgment?.worldPhase || latestPlanState?.worldPhase || null, worldOutcome: postJudgment?.worldOutcome || latestPlanState?.lastWorldOutcome || null, tensionDirection: postJudgment?.tensionDirection || state.storyState?.rhythm?.lastTensionDirection || null, responders, silentParticipants, conversationSettled: settlement.settled, messagesCreated, engine: engineInfo, runtime: { director: postJudgment?.runtime || (directorRuntime ? { timeToFirstTokenMs: directorRuntime.timeToFirstTokenMs, contextTokens: Number(directorRuntime.threadUsage?.last?.inputTokens || 0), outputTokens: Number(directorRuntime.threadUsage?.last?.outputTokens || 0), threadRolledOver: directorRuntime.threadRolledOver } : null), characters: characterRuntime } };
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
