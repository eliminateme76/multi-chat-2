import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const port = 3101;
const baseUrl = `http://127.0.0.1:${port}`;
const projectId = randomUUID();
const sceneId = randomUUID();
const characterIds = [randomUUID(), randomUUID(), randomUUID()];
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let server;
let serverOutput = '';
let createdWorldId;
let clonedWorldId;
let importedWorldId;
let worldDraftId;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const requestResponse = async (path, options) => {
  const separator = path.includes('?') ? '&' : '?';
  return fetch(`${baseUrl}${path}${separator}projectId=${projectId}`, options);
};
const request = async (path, options) => {
  const response = await requestResponse(path, options);
  if (!response.ok) throw new Error(`${path}: ${await response.text()}`);
  return response.json();
};

async function seedTemporaryProject() {
  await pool.query('BEGIN');
  try {
    const storyState = { version: 1, arcPhase: 'setup', tension: 45, pacing: 'steady', activeTensions: [{ id: 'locked-box', summary: '잠긴 상자의 정체와 숨겨진 열쇠', involvedCharacterIds: characterIds, pressure: 45, introducedAtSequence: 0 }], openQuestions: [{ id: 'who-hid-key', text: '누가 왜 열쇠를 숨겼는가?', involvedCharacterIds: characterIds, urgency: 50, introducedAtSequence: 0 }], recentBeats: [], lastDirectorSequence: 0 };
    await pool.query(`INSERT INTO projects (id,title,location,mood,scene_time,description,rules,public_direction,private_director_state,story_state)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [projectId, 'API 검증 세계', '검증실', '긴장', '자정', '세 인물이 잠긴 상자를 조사한다.', '공개된 증거만 사용한다.', '상자의 단서를 구체적으로 조사하세요.', '두 번째 인물이 열쇠를 숨겼다.', JSON.stringify(storyState)]);
    for (const [index, id] of characterIds.entries()) await pool.query(`INSERT INTO characters (id,project_id,name,role,personality,speech_style,goal,secret,emotion,sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, projectId, `검증인물${index + 1}`, '조사자', '침착함, 관찰력', '간결한 존댓말', '상자의 정체를 밝힌다.', `개인 비밀 ${index + 1}`, '집중', index]);
    await pool.query(`INSERT INTO scenes (id,project_id,scene_number,location,mood,scene_time,description,summary,public_direction,private_director_state,dramatic_state)
      VALUES ($1,$2,1,$3,$4,$5,$6,$6,$7,$8,$9)`, [sceneId, projectId, '검증실', '긴장', '자정', '세 인물이 잠긴 상자를 조사한다.', '상자의 단서를 구체적으로 조사하세요.', '두 번째 인물이 열쇠를 숨겼다.', JSON.stringify({ objective: '상자를 열 방법을 결정한다.', stakes: '서로의 신뢰', dilemma: '열쇠를 숨긴 이를 추궁할지 우회할지', beatType: 'choice', targetTension: 50, participantIds: characterIds })]);
    for (const id of characterIds) await pool.query('INSERT INTO scene_participants(scene_id,character_id,joined_sequence) VALUES ($1,$2,0)', [sceneId, id]);
    await pool.query('COMMIT');
  } catch (error) { await pool.query('ROLLBACK'); throw error; }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { await request('/api/state'); return; } catch { await sleep(250); }
  }
  throw new Error(`Server did not become ready.\n${serverOutput}`);
}

try {
  await seedTemporaryProject();
  server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (chunk) => { serverOutput += chunk; });
  server.stderr.on('data', (chunk) => { serverOutput += chunk; });
  await waitForServer();
  const catalog = (await request('/api/models')).models;
  const testModel = catalog.find((model) => model.id === 'gpt-5.6-luna') || catalog[0];
  if (!testModel?.efforts?.length) throw new Error('Codex model catalog did not provide a usable model and reasoning effort.');
  const testEffort = testModel.efforts.includes(testModel.defaultEffort) ? testModel.defaultEffort : testModel.efforts[0];
  const worldDraft = await request('/api/world-drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  worldDraftId = worldDraft.id;
  const initialRuntimeSettings = await request('/api/runtime/settings');
  if (!initialRuntimeSettings.worldBuilders.some((builder) => builder.id === worldDraftId)) throw new Error('Active World Builder is missing from runtime settings.');
  const runtimePayload = {
    project: initialRuntimeSettings.project,
    characters: initialRuntimeSettings.characters.map((character) => ({ id: character.id, modelOverride: testModel.id, reasoningEffortOverride: testEffort })),
    worldBuilders: initialRuntimeSettings.worldBuilders.map((builder) => ({ id: builder.id, model: testModel.id, reasoningEffort: testEffort }))
  };
  const savedRuntimeSettings = await request('/api/runtime/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(runtimePayload) });
  if (savedRuntimeSettings.characters.some((character) => character.effectiveModel !== testModel.id || character.effectiveReasoningEffort !== testEffort)) throw new Error('Character runtime settings were not saved.');
  if (savedRuntimeSettings.worldBuilders.some((builder) => builder.model !== testModel.id || builder.reasoningEffort !== testEffort)) throw new Error('World Builder runtime settings were not saved.');
  const invalidPayload = structuredClone(runtimePayload);
  invalidPayload.project.character.model = 'unavailable-verification-model';
  const invalidResponse = await requestResponse('/api/runtime/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(invalidPayload) });
  if (invalidResponse.ok) throw new Error('Invalid runtime settings were accepted.');
  const afterRejectedSettings = await request('/api/runtime/settings');
  if (afterRejectedSettings.project.character.model !== savedRuntimeSettings.project.character.model || afterRejectedSettings.characters.some((character) => character.effectiveModel !== testModel.id)) throw new Error('Rejected runtime settings partially changed the database.');
  await request(`/api/world-drafts/${worldDraftId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: {
    world: { title: '초안 검증 세계', location: '빈 역 승강장', mood: '고요한 미스터리', time: '막차가 끊긴 밤', description: '두 인물이 오지 않는 열차를 기다리고 있다.', rules: '시간표에 없는 열차에는 함부로 타지 않는다.', presentationMode: 'scene', dramaIntensity: 'balanced' },
    story: { premise: '오지 않는 열차와 사라진 승객의 비밀을 좇는다.', openingQuestion: '두 사람은 시간표에 없는 열차를 탈 것인가?', coreTensions: [{ summary: '열차에 타야 하는 이유와 타면 안 되는 이유가 충돌한다.', involvedCharacterKeys: ['hana','jun'], pressure: 48 }] },
    characters: [
      { key: 'hana', name: '하나', gender: '여성', role: '역무원', emoji: '◇', color: '#6757c8', personality: '침착하고 세심함', speechStyle: '차분한 존댓말', goal: '사라진 승객을 찾는다.', secret: '시간표를 몰래 바꾸었다.', emotion: '경계' },
      { key: 'jun', name: '준', gender: '남성', role: '여행자', emoji: '○', color: '#b66b73', personality: '낙천적이지만 집요함', speechStyle: '부드러운 반말', goal: '마지막 열차에 탄다.', secret: '사라진 승객의 편지를 갖고 있다.', emotion: '호기심' }
    ],
    relationships: [{ characterKeys: ['hana','jun'], label: '서로의 목적을 의심하는 임시 동행', score: 42 }], missingItems: []
  } }) });
  const createdWorld = await request(`/api/world-drafts/${worldDraftId}/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  createdWorldId = createdWorld.projectId;
  if (createdWorld.state.world.title !== '초안 검증 세계' || createdWorld.state.characters.length !== 2 || createdWorld.state.sceneNumber !== 1) throw new Error('World draft creation validation failed.');
  const repairId = randomUUID();
  const repairState = (await request('/api/state'));
  const repairProposal = {
    summary: '검증용 상태 보정', storyState: { ...repairState.storyState, tension: 46 },
    sceneState: { objective: '상자의 다음 단서를 선택한다.', stakes: '조사자 사이의 신뢰', dilemma: '직접 열지 도움을 기다릴지', beatType: 'choice', targetTension: 50, participantIds: characterIds.slice(0, 2) },
    participantIds: characterIds.slice(0, 2), relationships: [], memoryDecisions: [],
    characterStates: repairState.characters.map((character) => ({ characterId: character.id, state: { currentGoal: character.goal, internalConflict: '신속한 확인과 안전 사이에서 망설인다.', beliefs: [], commitments: [], developmentNotes: [], lastChangedSequence: 0 } }))
  };
  await pool.query(`INSERT INTO story_repair_proposals(id,project_id,source_world_sequence,proposal) VALUES ($1,$2,0,$3)`, [repairId, projectId, JSON.stringify(repairProposal)]);
  const appliedRepair = await request(`/api/story-repair/${repairId}/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!appliedRepair.applied || appliedRepair.state.participants.length !== 2 || appliedRepair.state.storyState.tension !== 46) throw new Error('Story repair transaction validation failed.');
  const before = await request('/api/state');
  const afterEvent = await request('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '검증용 사건: 상자 안에서 진동이 느껴진다.' }) });
  const queued = await request('/api/turns', { method: 'POST' });
  let operation;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    operation = await request(`/api/operations/${queued.operationId}`);
    if (['COMPLETED', 'FAILED'].includes(operation.status)) break;
    await sleep(500);
  }
  if (operation?.status !== 'COMPLETED') throw new Error(`Progression failed: ${operation?.error || 'timeout'}`);
  const afterTurn = await request('/api/state');
  if (afterEvent.sceneNumber !== before.sceneNumber || afterEvent.logs.length !== before.logs.length + 1 || afterEvent.logs.at(-1).type !== 'event') throw new Error('Mid-conversation event validation failed.');
  const latestCharacterEntry = afterTurn.logs.findLast((entry) => entry.type === 'message');
  if (afterTurn.logs.length < before.logs.length + 2 || !latestCharacterEntry || afterTurn.turn <= before.turn) throw new Error('Turn persistence validation failed.');
  if (!Array.isArray(latestCharacterEntry.payload?.contentBlocks) || !latestCharacterEntry.payload.contentBlocks.length || latestCharacterEntry.payload.contentBlocks.some((block) => !['DIALOGUE','ACTION'].includes(block.type) || !block.text)) throw new Error('Ordered character content blocks were not persisted.');
  if (!['build','pressure','choice','consequence','release'].includes(operation.result?.worldPhase) || !['open','success','qualified_success','setback'].includes(operation.result?.worldOutcome) || !['rise','hold','fall'].includes(operation.result?.tensionDirection)) throw new Error('Structured world-resolution metadata is missing from the progression result.');
  if (afterTurn.storyState.rhythm.phase !== operation.result.worldPhase || afterTurn.storyState.rhythm.lastOutcome !== operation.result.worldOutcome) throw new Error('Persisted story rhythm does not match the World Director resolution.');
  if (!['NONE','SELF','CHARACTER_ATTEMPT','WORLD_ATTEMPT'].includes(latestCharacterEntry.payload?.actionScope) || 'beatOutcome' in latestCharacterEntry.payload) throw new Error('Character/world authority boundary was not persisted correctly.');
  if (operation.result?.engine?.name !== 'concordia' || operation.result?.engine?.version !== '2.4.0' || operation.payload?.concordiaStage !== 'GM_COMPLETED') throw new Error('Concordia engine metadata/checkpoint is missing.');
  if (operation.steps?.length !== 1) throw new Error('A progression operation generated more than one character response.');
  const persistedRuntime = (await pool.query(`SELECT p.director_thread_turn_count AS "directorTurns",p.director_thread_context_tokens AS "directorTokens",p.director_thread_contract_version AS "directorContractVersion",
    c.active_thread_turn_count AS "characterTurns",c.active_thread_context_tokens AS "characterTokens",c.thread_contract_version AS "characterContractVersion"
    FROM projects p JOIN characters c ON c.project_id=p.id AND c.id=$2 WHERE p.id=$1`, [projectId, operation.steps[0].characterId])).rows[0];
  if (Number(persistedRuntime.directorTurns) < 2 || Number(persistedRuntime.characterTurns) !== 1 || Number(persistedRuntime.directorTokens) <= 0 || Number(persistedRuntime.characterTokens) <= 0 || Number(persistedRuntime.directorContractVersion) !== 5 || Number(persistedRuntime.characterContractVersion) !== 5) throw new Error(`Persistent thread runtime metadata was not stored: ${JSON.stringify(persistedRuntime)}`);
  const firstPlanView = (await request('/api/runtime/director-plan')).plan;
  if (!firstPlanView?.rationale || !firstPlanView.responders?.length || firstPlanView.action !== (operation.result.directorPlan?.action || operation.result.directorAction)) throw new Error('Sanitized reaction queue audit is missing.');
  const queuedCharacterId = afterTurn.participants.find((participant) => participant.characterId !== operation.steps[0].characterId)?.characterId || afterTurn.participants[0].characterId;
  const reusableState = { ...afterTurn.dramaticState, plannedResponderIds: [queuedCharacterId], planResponderIds: [...new Set([operation.steps[0].characterId, queuedCharacterId])], planStartedSequence: afterTurn.latestSceneSequence, responsesConsumed: 1 };
  await pool.query(`UPDATE scenes SET dramatic_state=$2,progress_signal='continue' WHERE id=$1`, [afterTurn.sceneId, JSON.stringify(reusableState)]);
  const queuedReuse = await request('/api/turns', { method: 'POST' });
  let reusedOperation;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    reusedOperation = await request(`/api/operations/${queuedReuse.operationId}`);
    if (['COMPLETED', 'FAILED'].includes(reusedOperation.status)) break;
    await sleep(500);
  }
  if (reusedOperation?.status !== 'COMPLETED' || !reusedOperation.result?.planReused || !reusedOperation.result?.runtime?.director || reusedOperation.payload?.concordiaStage !== 'GM_COMPLETED' || reusedOperation.steps?.length !== 1) throw new Error(`Reusable Director plan plus mandatory post-GM validation failed: ${reusedOperation?.error || reusedOperation?.status}`);
  const reusedPlanView = (await request('/api/runtime/director-plan')).plan;
  if (!reusedPlanView?.latestOperation?.reused || !reusedPlanView.responders?.length) throw new Error(`Post-GM reaction queue is not visible in the monitor API: ${JSON.stringify(reusedPlanView)}`);
  const runtimeSnapshot = await request('/api/runtime/snapshot');
  const progressionRun = runtimeSnapshot.runs.find((run) => run.projectId === projectId && run.type === 'progression' && run.status === 'completed');
  const characterGeneration = progressionRun?.stages.find((stage) => stage.name === 'model_generate' && stage.metadata.usage?.startsWith('캐릭터 응답'));
  if (!characterGeneration || characterGeneration.metadata.model !== testModel.id || characterGeneration.metadata.effort !== testEffort) throw new Error('The configured model/effort was not used by the next progression.');
  if (!progressionRun.stages.some((stage) => stage.name === 'concordia_entity') || !progressionRun.stages.some((stage) => stage.name === 'concordia_game_master') || runtimeSnapshot.resources?.concordiaWorker?.version !== '2.4.0') throw new Error('Concordia runtime telemetry is missing.');
  const settingsWithThreads = await request('/api/runtime/settings');
  const threadIdsBeforeSave = new Map(settingsWithThreads.characters.map((character) => [character.id, character.threadId]));
  const preservePayload = {
    project: settingsWithThreads.project,
    characters: settingsWithThreads.characters.map((character) => ({ id: character.id, modelOverride: character.modelOverride, reasoningEffortOverride: character.reasoningEffortOverride })),
    worldBuilders: settingsWithThreads.worldBuilders.map((builder) => ({ id: builder.id, model: builder.model, reasoningEffort: builder.reasoningEffort }))
  };
  const settingsAfterSave = await request('/api/runtime/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(preservePayload) });
  if (settingsAfterSave.characters.some((character) => character.threadId !== threadIdsBeforeSave.get(character.id))) throw new Error('Saving runtime settings replaced a character thread id.');
  preservePayload.characters[0].modelOverride = null;
  preservePayload.characters[0].reasoningEffortOverride = null;
  const inheritedSettings = await request('/api/runtime/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(preservePayload) });
  const inheritedCharacter = inheritedSettings.characters.find((character) => character.id === preservePayload.characters[0].id);
  if (inheritedCharacter.modelOverride !== null || inheritedCharacter.reasoningEffortOverride !== null || inheritedCharacter.effectiveModel !== inheritedSettings.project.character.model || inheritedCharacter.threadId !== threadIdsBeforeSave.get(inheritedCharacter.id)) throw new Error('Character inheritance did not preserve the existing thread.');
  const cloned = await request('/api/projects/clone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'API 검증 복제 월드' }) });
  clonedWorldId = cloned.projectId;
  if (cloned.state.characters.length !== afterTurn.characters.length || cloned.state.characters.some((character) => afterTurn.characters.some((source) => source.id === character.id) || character.activeThreadId)) throw new Error('Playthrough clone did not issue clean world-local character/thread ids.');
  if (cloned.state.repairNeeded || !Object.keys(cloned.state.storyState || {}).length || cloned.state.dramaticState.participantIds.length !== cloned.state.characters.length) throw new Error('A fresh cloned playthrough was incorrectly treated as a legacy world.');
  const resetCloneResponse = await fetch(`${baseUrl}/api/projects/reset?projectId=${clonedWorldId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!resetCloneResponse.ok) throw new Error(`Clone reset failed: ${await resetCloneResponse.text()}`);
  const resetClone = await resetCloneResponse.json();
  if (resetClone.repairNeeded || resetClone.logs.length || !Object.keys(resetClone.storyState || {}).length || resetClone.dramaticState.participantIds.length !== resetClone.characters.length) throw new Error('A reset playthrough did not restore a complete initial story state.');
  const worldPackage = await request('/api/projects/export');
  if (worldPackage.format !== 'sceneweaver-world' || worldPackage.version !== 1 || worldPackage.characters.length !== characterIds.length || 'simulationEngine' in worldPackage) throw new Error('Portable world export is incomplete or engine-specific.');
  const imported = await request('/api/projects/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ worldPackage }) });
  importedWorldId = imported.projectId;
  if (imported.state.logs.length || imported.state.characters.length !== characterIds.length || imported.state.characters.some((character) => characterIds.includes(character.id) || character.activeThreadId) || imported.state.world.title !== worldPackage.world.title || imported.state.world.rules !== worldPackage.world.rules || imported.state.simulationEngine !== 'concordia') throw new Error('Portable world import did not create an independent Concordia world.');
  console.log(JSON.stringify({ createdWorldId, clonedWorldId, importedWorldId, portableWorldImport: true, createdCharacters: createdWorld.state.characters.length, configuredModel: testModel.id, configuredEffort: testEffort, preservedThreads: [...threadIdsBeforeSave.values()].filter(Boolean).length, inheritedCharacter: inheritedCharacter.name, beforeScene: before.sceneNumber, afterScene: afterEvent.sceneNumber, afterTurn: afterTurn.turn, worldResolution: `${operation.result.worldPhase}/${operation.result.worldOutcome}/${operation.result.tensionDirection}`, signal: afterTurn.sceneSignal, oneResponsePerOperation: operation.steps.length === 1, reusedDirectorPlan: reusedOperation.result.planReused, firstOperationMs: Date.parse(operation.completedAt) - Date.parse(operation.startedAt), reusedOperationMs: Date.parse(reusedOperation.completedAt) - Date.parse(reusedOperation.startedAt), firstRuntime: operation.result.runtime }, null, 2));
} finally {
  server?.kill();
  if (importedWorldId) await pool.query('DELETE FROM projects WHERE id=$1', [importedWorldId]);
  if (clonedWorldId) await pool.query('DELETE FROM projects WHERE id=$1', [clonedWorldId]);
  if (createdWorldId) await pool.query('DELETE FROM projects WHERE id=$1', [createdWorldId]);
  if (worldDraftId) await pool.query('DELETE FROM world_creation_drafts WHERE id=$1', [worldDraftId]);
  await pool.query('DELETE FROM projects WHERE id=$1', [projectId]);
  await pool.end();
}
