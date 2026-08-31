import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCodexTurn } from './codex-client.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Copy .env.example to .env.');
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const root = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
app.use(express.json());
app.use(express.static(root));

const required = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`); return value.trim(); };
async function getState(queryable = pool) {
  const project = (await queryable.query('SELECT id,title,location,mood,scene_time AS time,description,rules,scene_number AS "sceneNumber",turn_number AS turn,director_note AS "directorNote" FROM projects WHERE id=$1', [PROJECT_ID])).rows[0];
  if (!project) return null;
  const [characters, relationships, entries] = await Promise.all([
    queryable.query('SELECT id,name,role,emoji,color,personality,speech_style AS "speechStyle",goal,secret,emotion FROM characters WHERE project_id=$1 ORDER BY sort_order', [PROJECT_ID]),
    queryable.query('SELECT from_character_id AS "from",to_character_id AS "to",label,score FROM relationships WHERE project_id=$1 ORDER BY created_at', [PROJECT_ID]),
    queryable.query('SELECT entry_type AS type,character_id AS "characterId",dialogue AS text,action,event_text AS "eventText" FROM scene_entries WHERE project_id=$1 ORDER BY sort_order', [PROJECT_ID])
  ]);
  return { world: { title: project.title, location: project.location, mood: project.mood, time: project.time, description: project.description, rules: project.rules }, sceneNumber: project.sceneNumber, turn: project.turn, directorNote: project.directorNote, characters: characters.rows, relationships: relationships.rows, logs: entries.rows.map((entry) => entry.type === 'event' ? { type: 'event', text: entry.eventText } : entry) };
}
async function nextOrder(client) { return Number((await client.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM scene_entries WHERE project_id=$1', [PROJECT_ID])).rows[0].next); }
app.get('/api/state', async (_req, res, next) => { try { const state = await getState(); if (!state) return res.status(404).json({ error: 'Run npm run db:setup first.' }); res.json(state); } catch (error) { next(error); } });
app.put('/api/world', async (req, res, next) => { try { const w = req.body; await pool.query('UPDATE projects SET title=$2,location=$3,mood=$4,scene_time=$5,description=$6,rules=$7,updated_at=NOW() WHERE id=$1', [PROJECT_ID, required(w.title, 'title'), required(w.location, 'location'), required(w.mood, 'mood'), required(w.time, 'time'), required(w.description, 'description'), typeof w.rules === 'string' ? w.rules.trim() : '']); res.json(await getState()); } catch (error) { next(error); } });
app.post('/api/characters', async (req, res, next) => { try { const c = req.body; const sort = (await pool.query('SELECT COALESCE(MAX(sort_order), -1)+1 AS next FROM characters WHERE project_id=$1', [PROJECT_ID])).rows[0].next; await pool.query('INSERT INTO characters (id,project_id,name,role,personality,speech_style,goal,secret,emoji,color,emotion,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [randomUUID(), PROJECT_ID, required(c.name, 'name'), required(c.role, 'role'), required(c.personality, 'personality'), required(c.speechStyle, 'speechStyle'), required(c.goal, 'goal'), required(c.secret, 'secret'), '✧', '#5c9c9b', '기대', sort]); res.json(await getState()); } catch (error) { next(error); } });
app.put('/api/characters/:id', async (req, res, next) => { try { const c = req.body; const result = await pool.query('UPDATE characters SET name=$2,role=$3,personality=$4,speech_style=$5,goal=$6,secret=$7,updated_at=NOW() WHERE id=$1 AND project_id=$8', [req.params.id, required(c.name, 'name'), required(c.role, 'role'), required(c.personality, 'personality'), required(c.speechStyle, 'speechStyle'), required(c.goal, 'goal'), required(c.secret, 'secret'), PROJECT_ID]); if (!result.rowCount) return res.status(404).json({ error: 'Character not found.' }); res.json(await getState()); } catch (error) { next(error); } });
app.post('/api/events', async (req, res, next) => { const client = await pool.connect(); try { const text = required(req.body.text, 'text'); await client.query('BEGIN'); await client.query('INSERT INTO scene_entries (id,project_id,entry_type,event_text,sort_order) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), PROJECT_ID, 'event', text, await nextOrder(client)]); await client.query(`UPDATE projects SET scene_number=scene_number+1,description=LEFT($2 || ' ' || description,300),director_note=$3,updated_at=NOW() WHERE id=$1`, [PROJECT_ID, text, '새 사건에 대한 각 인물의 서로 다른 반응을 이끌어 내세요. 개인 비밀은 각 Agent의 컨텍스트에만 유지됩니다.']); await client.query('COMMIT'); res.json(await getState()); } catch (error) { await client.query('ROLLBACK'); next(error); } finally { client.release(); } });
app.post('/api/turns', async (_req, res, next) => { let client; let lockHeld = false; let transactionStarted = false; try { client = await pool.connect(); const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [PROJECT_ID]); if (!lock.rows[0].locked) return res.status(409).json({ error: '이미 다른 장면을 생성하고 있습니다. 완료 후 다시 시도하세요.' }); lockHeld = true; const state = await getState(client); const character = state.characters[state.turn % state.characters.length]; if (!character) throw new Error('At least one character is required.'); const turn = await generateCodexTurn({ character, state }); await client.query('BEGIN'); transactionStarted = true; await client.query('INSERT INTO scene_entries (id,project_id,entry_type,character_id,dialogue,action,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), PROJECT_ID, 'message', character.id, turn.dialogue, turn.action, await nextOrder(client)]); await client.query('UPDATE characters SET emotion=$2,updated_at=NOW() WHERE id=$1', [character.id, turn.emotion]); await client.query('UPDATE projects SET turn_number=turn_number+1,director_note=$2,updated_at=NOW() WHERE id=$1', [PROJECT_ID, `${character.name} Agent가 Codex로 응답했습니다. 다음 Agent에는 공개된 대화만 전달하세요.`]); await client.query('COMMIT'); transactionStarted = false; res.json(await getState(client)); } catch (error) { if (transactionStarted) await client.query('ROLLBACK'); next(error); } finally { try { if (lockHeld) await client?.query('SELECT pg_advisory_unlock(hashtext($1))', [PROJECT_ID]); } finally { client?.release(); } } });
app.use((error, _req, res, _next) => { console.error(error); res.status(400).json({ error: error.message || 'Request failed.' }); });
app.listen(port, host, () => console.log(`Sceneweaver running at http://${host}:${port}`));