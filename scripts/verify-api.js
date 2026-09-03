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
    await pool.query(`INSERT INTO projects (id,title,location,mood,scene_time,description,rules,public_direction,private_director_state)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [projectId, 'API 검증 세계', '검증실', '긴장', '자정', '세 인물이 잠긴 상자를 조사한다.', '공개된 증거만 사용한다.', '상자의 단서를 구체적으로 조사하세요.', '두 번째 인물이 열쇠를 숨겼다.']);
    for (const [index, id] of characterIds.entries()) await pool.query(`INSERT INTO characters (id,project_id,name,role,personality,speech_style,goal,secret,emotion,sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, projectId, `검증인물${index + 1}`, '조사자', '침착함, 관찰력', '간결한 존댓말', '상자의 정체를 밝힌다.', `개인 비밀 ${index + 1}`, '집중', index]);
    await pool.query(`INSERT INTO scenes (id,project_id,scene_number,location,mood,scene_time,description,summary,public_direction,private_director_state)
      VALUES ($1,$2,1,$3,$4,$5,$6,$6,$7,$8)`, [sceneId, projectId, '검증실', '긴장', '자정', '세 인물이 잠긴 상자를 조사한다.', '상자의 단서를 구체적으로 조사하세요.', '두 번째 인물이 열쇠를 숨겼다.']);
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
    world: { title: '초안 검증 세계', location: '빈 역 승강장', mood: '고요한 미스터리', time: '막차가 끊긴 밤', description: '두 인물이 오지 않는 열차를 기다리고 있다.', rules: '시간표에 없는 열차에는 함부로 타지 않는다.', presentationMode: 'scene' },
    characters: [
      { key: 'hana', name: '하나', gender: '여성', role: '역무원', emoji: '◇', color: '#6757c8', personality: '침착하고 세심함', speechStyle: '차분한 존댓말', goal: '사라진 승객을 찾는다.', secret: '시간표를 몰래 바꾸었다.', emotion: '경계' },
      { key: 'jun', name: '준', gender: '남성', role: '여행자', emoji: '○', color: '#b66b73', personality: '낙천적이지만 집요함', speechStyle: '부드러운 반말', goal: '마지막 열차에 탄다.', secret: '사라진 승객의 편지를 갖고 있다.', emotion: '호기심' }
    ],
    relationships: [{ characterKeys: ['hana','jun'], label: '서로의 목적을 의심하는 임시 동행', score: 42 }], missingItems: []
  } }) });
  const createdWorld = await request(`/api/world-drafts/${worldDraftId}/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  createdWorldId = createdWorld.projectId;
  if (createdWorld.state.world.title !== '초안 검증 세계' || createdWorld.state.characters.length !== 2 || createdWorld.state.sceneNumber !== 1) throw new Error('World draft creation validation failed.');
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
  if (afterTurn.logs.length < before.logs.length + 2 || afterTurn.logs.at(-1).type !== 'message' || afterTurn.turn <= before.turn) throw new Error('Turn persistence validation failed.');
  const runtimeSnapshot = await request('/api/runtime/snapshot');
  const progressionRun = runtimeSnapshot.runs.find((run) => run.projectId === projectId && run.type === 'progression' && run.status === 'completed');
  const characterGeneration = progressionRun?.stages.find((stage) => stage.name === 'model_generate' && stage.metadata.usage?.startsWith('캐릭터 응답'));
  if (!characterGeneration || characterGeneration.metadata.model !== testModel.id || characterGeneration.metadata.effort !== testEffort) throw new Error('The configured model/effort was not used by the next progression.');
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
  console.log(JSON.stringify({ createdWorldId, createdCharacters: createdWorld.state.characters.length, configuredModel: testModel.id, configuredEffort: testEffort, preservedThreads: [...threadIdsBeforeSave.values()].filter(Boolean).length, inheritedCharacter: inheritedCharacter.name, beforeScene: before.sceneNumber, afterScene: afterEvent.sceneNumber, afterTurn: afterTurn.turn, signal: afterTurn.sceneSignal }, null, 2));
} finally {
  server?.kill();
  if (createdWorldId) await pool.query('DELETE FROM projects WHERE id=$1', [createdWorldId]);
  if (worldDraftId) await pool.query('DELETE FROM world_creation_drafts WHERE id=$1', [worldDraftId]);
  await pool.query('DELETE FROM projects WHERE id=$1', [projectId]);
  await pool.end();
}
