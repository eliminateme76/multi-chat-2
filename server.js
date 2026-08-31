import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCharacterSuggestion, generateCodexTurn, generateEventSuggestions } from './codex-client.js';
import { buildTurnContext, createSceneFromEvent, getStoryState, persistGeneratedTurn } from './story-engine.js';
import { endStage, failRun, failStage, finishRun, snapshot, startRun, startStage, subscribe } from './runtime-telemetry.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Copy .env.example to .env.');
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const root = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const EVENT_TYPES = new Set(['일상', '관계', '연락', '선택', '발견', '돌발', '시간 전환', '분위기', '일반']);
app.use(express.json());
app.use(express.static(root));

const required = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
};
const projectIdFrom = (req) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : DEFAULT_PROJECT_ID;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) throw new Error('Invalid projectId.');
  return projectId;
};

app.get('/api/projects', async (_req, res, next) => {
  try { res.json((await pool.query('SELECT id,title,mood FROM projects ORDER BY created_at,title')).rows); } catch (error) { next(error); }
});

app.get('/api/runtime/snapshot', (_req, res) => res.json(snapshot()));
app.get('/api/runtime/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
  const unsubscribe = subscribe((event) => res.write(`event: runtime\ndata: ${event}\n\n`));
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  req.on('close', () => { clearInterval(keepAlive); unsubscribe(); });
});

app.get('/api/state', async (req, res, next) => {
  try {
    const state = await getStoryState(pool, projectIdFrom(req));
    if (!state) return res.status(404).json({ error: 'Project not found. Run npm run migrate.' });
    res.json(state);
  } catch (error) { next(error); }
});

app.put('/api/world', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const projectId = projectIdFrom(req); const world = req.body;
    const values = [projectId, required(world.title, 'title'), required(world.location, 'location'), required(world.mood, 'mood'), required(world.time, 'time'), required(world.description, 'description'), typeof world.rules === 'string' ? world.rules.trim() : ''];
    await client.query('BEGIN');
    await client.query('UPDATE projects SET title=$2,location=$3,mood=$4,scene_time=$5,description=$6,rules=$7,updated_at=NOW() WHERE id=$1', values);
    await client.query("UPDATE scenes SET location=$2,mood=$3,scene_time=$4,description=$5,updated_at=NOW() WHERE project_id=$1 AND status='active'", [projectId, values[2], values[3], values[4], values[5]]);
    await client.query('COMMIT');
    res.json(await getStoryState(client, projectId));
  } catch (error) { await client.query('ROLLBACK'); next(error); } finally { client.release(); }
});

app.post('/api/characters', async (req, res, next) => {
  try {
    const projectId = projectIdFrom(req); const character = req.body;
    const sort = (await pool.query('SELECT COALESCE(MAX(sort_order), -1)+1 AS next FROM characters WHERE project_id=$1', [projectId])).rows[0].next;
    await pool.query('INSERT INTO characters (id,project_id,name,role,gender,personality,speech_style,goal,secret,emoji,color,emotion,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [randomUUID(), projectId, required(character.name, 'name'), required(character.role, 'role'), required(character.gender, 'gender'), required(character.personality, 'personality'), required(character.speechStyle, 'speechStyle'), required(character.goal, 'goal'), required(character.secret, 'secret'), '✧', '#5c9c9b', '기대', sort]);
    res.json(await getStoryState(pool, projectId));
  } catch (error) { next(error); }
});

app.post('/api/characters/suggest', async (req, res, next) => {
  let runId;
  try {
    const projectId = projectIdFrom(req);
    runId = startRun({ type: 'character_suggestion', projectId });
    const state = await getStoryState(pool, projectId);
    if (!state) { const error = new Error('Project not found.'); failRun(runId, error); return res.status(404).json({ error: error.message }); }
    const result = await generateCharacterSuggestion(state, runId);
    finishRun(runId, { characterName: result.name });
    res.json(result);
  } catch (error) { failRun(runId, error); next(error); }
});

app.post('/api/events/suggest', async (req, res, next) => {
  let runId;
  try {
    const projectId = projectIdFrom(req);
    runId = startRun({ type: 'event_suggestions', projectId });
    const state = await getStoryState(pool, projectId);
    if (!state) { const error = new Error('Project not found.'); failRun(runId, error); return res.status(404).json({ error: error.message }); }
    const desiredTypes = Array.isArray(req.body.desiredTypes) ? req.body.desiredTypes.filter((type) => EVENT_TYPES.has(type) && type !== '일반') : [];
    const result = await generateEventSuggestions(state, runId, desiredTypes);
    finishRun(runId, { count: result.suggestions.length });
    res.json(result);
  } catch (error) { failRun(runId, error); next(error); }
});

app.put('/api/characters/:id', async (req, res, next) => {
  try {
    const projectId = projectIdFrom(req); const character = req.body;
    const result = await pool.query('UPDATE characters SET name=$2,role=$3,gender=$4,personality=$5,speech_style=$6,goal=$7,secret=$8,updated_at=NOW() WHERE id=$1 AND project_id=$9', [req.params.id, required(character.name, 'name'), required(character.role, 'role'), required(character.gender, 'gender'), required(character.personality, 'personality'), required(character.speechStyle, 'speechStyle'), required(character.goal, 'goal'), required(character.secret, 'secret'), projectId]);
    if (!result.rowCount) return res.status(404).json({ error: 'Character not found.' });
    res.json(await getStoryState(pool, projectId));
  } catch (error) { next(error); }
});

app.post('/api/events', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const projectId = projectIdFrom(req); const text = required(req.body.text, 'text');
    const nextTime = typeof req.body.time === 'string' ? req.body.time.trim().slice(0, 80) : '';
    const eventType = EVENT_TYPES.has(req.body.eventType) ? req.body.eventType : '일반';
    await client.query('BEGIN');
    await createSceneFromEvent(client, projectId, text, nextTime, eventType);
    await client.query('COMMIT');
    res.json(await getStoryState(client, projectId));
  } catch (error) { await client.query('ROLLBACK'); next(error); } finally { client.release(); }
});

app.get('/api/turns/next-speaker', async (req, res, next) => {
  try {
    const state = await getStoryState(pool, projectIdFrom(req));
    if (!state) return res.status(404).json({ error: 'Project not found.' });
    const character = state.characters[state.turn % state.characters.length];
    res.json({ character: { id: character.id, name: character.name, portraitUrl: character.portraitUrl, portraitPosition: character.portraitPosition, emoji: character.emoji, color: character.color } });
  } catch (error) { next(error); }
});

app.post('/api/turns', async (req, res, next) => {
  let client; let lockHeld = false; let transactionStarted = false; let projectId; let runId; let activeStage;
  try {
    projectId = projectIdFrom(req);
    runId = startRun({ type: 'turn', projectId });
    client = await pool.connect();
    activeStage = startStage(runId, 'project_lock');
    const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [projectId]);
    if (!lock.rows[0].locked) { const error = new Error('이미 다른 턴을 생성하고 있습니다. 완료 후 다시 시도하세요.'); failStage(runId, activeStage, error); failRun(runId, error); return res.status(409).json({ error: error.message }); }
    lockHeld = true;
    endStage(runId, activeStage);
    const context = await buildTurnContext(client, projectId, runId);
    if (!context) { const error = new Error('Project not found.'); failRun(runId, error); return res.status(404).json({ error: error.message }); }
    const turn = await generateCodexTurn(context);
    activeStage = startStage(runId, 'db_transaction');
    await client.query('BEGIN'); transactionStarted = true;
    const outcome = await persistGeneratedTurn(client, context, turn);
    await client.query('COMMIT'); transactionStarted = false;
    endStage(runId, activeStage, { memoryWritten: Boolean(turn.memory), relationshipChanges: turn.relationshipChanges.length, sceneSignal: turn.sceneSignal });
    const state = await getStoryState(client, projectId);
    state.turnOutcome = { spoke: !outcome.skipped, characterId: context.character.id, characterName: context.character.name };
    finishRun(runId, { characterName: context.character.name, sceneSignal: turn.sceneSignal, skipped: outcome.skipped });
    res.json(state);
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK');
    failStage(runId, activeStage, error);
    failRun(runId, error);
    next(error);
  } finally {
    try { if (lockHeld) await client?.query('SELECT pg_advisory_unlock(hashtext($1))', [projectId]); } finally { client?.release(); }
  }
});

app.use((error, _req, res, _next) => { console.error(error); res.status(400).json({ error: error.message || 'Request failed.' }); });
app.listen(port, host, () => console.log(`Sceneweaver running at http://${host}:${port}`));
