import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const baseUrl = 'http://127.0.0.1:3000';
const testEvent = '검증용 사건: 종소리가 울린다.';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const server = spawn(process.execPath, ['server.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
let before;
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
  before = await request('/api/state');
  const afterEvent = await request('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: testEvent }) });
  const afterTurn = await request('/api/turns', { method: 'POST' });
  if (afterEvent.logs.length !== before.logs.length + 1 || afterTurn.logs.length !== afterEvent.logs.length + 1 || afterTurn.logs.at(-1).type !== 'message') throw new Error('API persistence validation failed.');
  console.log(JSON.stringify({ beforeLogs: before.logs.length, afterEventLogs: afterEvent.logs.length, afterTurnLogs: afterTurn.logs.length, sceneNumber: afterEvent.sceneNumber, turnNumber: afterTurn.turn }, null, 2));
} finally {
  server.kill();
  if (before) {
    await pool.query('BEGIN');
    try {
      await pool.query('DELETE FROM scene_entries WHERE project_id=$1', ['00000000-0000-4000-8000-000000000001']);
      for (const [sortOrder, entry] of before.logs.entries()) {
        if (entry.type === 'event') await pool.query('INSERT INTO scene_entries (id,project_id,entry_type,event_text,sort_order) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), '00000000-0000-4000-8000-000000000001', 'event', entry.text, sortOrder]);
        else await pool.query('INSERT INTO scene_entries (id,project_id,entry_type,character_id,dialogue,action,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), '00000000-0000-4000-8000-000000000001', 'message', entry.characterId, entry.text, entry.action, sortOrder]);
      }
      for (const character of before.characters) await pool.query('UPDATE characters SET emotion=$2,updated_at=NOW() WHERE id=$1', [character.id, character.emotion]);
      await pool.query('UPDATE projects SET title=$2,location=$3,mood=$4,scene_time=$5,description=$6,rules=$7,scene_number=$8,turn_number=$9,director_note=$10,updated_at=NOW() WHERE id=$1', ['00000000-0000-4000-8000-000000000001', before.world.title, before.world.location, before.world.mood, before.world.time, before.world.description, before.world.rules, before.sceneNumber, before.turn, before.directorNote]);
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  }
  await pool.end();
}