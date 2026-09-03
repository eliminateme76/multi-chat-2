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
const request = async (path, options) => {
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetch(`${baseUrl}${path}${separator}projectId=${projectId}`, options);
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
  const worldDraft = await request('/api/world-drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  worldDraftId = worldDraft.id;
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
  console.log(JSON.stringify({ createdWorldId, createdCharacters: createdWorld.state.characters.length, beforeScene: before.sceneNumber, afterScene: afterEvent.sceneNumber, afterTurn: afterTurn.turn, signal: afterTurn.sceneSignal }, null, 2));
} finally {
  server?.kill();
  if (createdWorldId) await pool.query('DELETE FROM projects WHERE id=$1', [createdWorldId]);
  if (worldDraftId) await pool.query('DELETE FROM world_creation_drafts WHERE id=$1', [worldDraftId]);
  await pool.query('DELETE FROM projects WHERE id=$1', [projectId]);
  await pool.end();
}
