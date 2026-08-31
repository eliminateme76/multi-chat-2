import 'dotenv/config';
import { spawn } from 'node:child_process';
import pg from 'pg';

const baseUrl = 'http://127.0.0.1:3000';
const testEvent = '검증용 사건: 종소리가 울린다.';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const server = spawn(process.execPath, ['server.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk; });
server.stderr.on('data', (chunk) => { serverOutput += chunk; });
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const request = async (path, options) => { const response = await fetch(`${baseUrl}${path}`, options); if (!response.ok) throw new Error(`${path}: ${await response.text()}`); return response.json(); };
async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { await request('/api/state'); return; } catch { await sleep(200); }
  }
  throw new Error(`Server did not become ready.\n${serverOutput}`);
}

try {
  await waitForServer();
  const before = await request('/api/state');
  const afterEvent = await request('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: testEvent }) });
  const afterTurn = await request('/api/turns', { method: 'POST' });
  if (afterEvent.logs.length !== before.logs.length + 1 || afterTurn.logs.length !== afterEvent.logs.length + 1 || afterTurn.logs.at(-1).type !== 'message') throw new Error('API persistence validation failed.');
  console.log(JSON.stringify({ beforeLogs: before.logs.length, afterEventLogs: afterEvent.logs.length, afterTurnLogs: afterTurn.logs.length, sceneNumber: afterEvent.sceneNumber, turnNumber: afterTurn.turn }, null, 2));
} finally {
  server.kill();
  await pool.query('DELETE FROM scene_entries WHERE event_text=$1', [testEvent]);
  await pool.query('DELETE FROM scene_entries WHERE project_id=$1 AND sort_order >= 3', ['00000000-0000-4000-8000-000000000001']);
  await pool.query("UPDATE projects SET scene_number=1,turn_number=0,description='늦은 밤. 폭풍우가 창을 두드리고, 오래된 마법서가 희미하게 빛난다.',director_note='세라의 비밀을 둘러싼 긴장을 유지하세요. 루카에게는 아직 확실한 증거가 없습니다.' WHERE id='00000000-0000-4000-8000-000000000001'");
  await pool.end();
}