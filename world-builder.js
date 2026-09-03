import { randomUUID } from 'node:crypto';
import { cleanupCodexThread, generateWorldDraft } from './codex-client.js';

const GENDERS = new Set(['여성', '남성', '논바이너리', '성별 없음']);
const MODES = new Set(['scene', 'chat']);
const INTENSITIES = new Set(['gentle', 'balanced', 'high']);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const KEY = /^[a-z][a-z0-9_-]{0,31}$/;

const emptyDraft = () => ({
  world: { title: '', location: '', mood: '', time: '', description: '', rules: '', presentationMode: 'scene', dramaIntensity: 'balanced' },
  story: { premise: '', openingQuestion: '', coreTensions: [] },
  characters: [], relationships: [], missingItems: []
});

const cleanString = (value, field, max, { required = true } = {}) => {
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  const cleaned = value.trim();
  if (required && !cleaned) throw new Error(`${field} is required.`);
  if (cleaned.length > max) throw new Error(`${field} is too long.`);
  return cleaned;
};

export function validateWorldDraft(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('월드 초안 형식이 올바르지 않습니다.');
  const sourceWorld = input.world;
  if (!sourceWorld || typeof sourceWorld !== 'object') throw new Error('월드 설정이 필요합니다.');
  const presentationMode = cleanString(sourceWorld.presentationMode, 'presentationMode', 10);
  if (!MODES.has(presentationMode)) throw new Error('presentationMode must be scene or chat.');
  const dramaIntensity = INTENSITIES.has(sourceWorld.dramaIntensity) ? sourceWorld.dramaIntensity : 'balanced';
  const world = {
    title: cleanString(sourceWorld.title, '세계 이름', 50),
    location: cleanString(sourceWorld.location, '첫 장소', 70),
    mood: cleanString(sourceWorld.mood, '분위기', 70),
    time: cleanString(sourceWorld.time, '첫 시간', 40),
    description: cleanString(sourceWorld.description, '첫 장면 설명', 300),
    rules: cleanString(sourceWorld.rules ?? '', '세계 규칙', 300, { required: false }),
    presentationMode, dramaIntensity
  };
  if (!Array.isArray(input.characters) || input.characters.length < 2 || input.characters.length > 6) throw new Error('캐릭터는 2명에서 6명까지 필요합니다.');
  const keys = new Set(); const names = new Set();
  const characters = input.characters.map((source, index) => {
    if (!source || typeof source !== 'object') throw new Error(`캐릭터 ${index + 1} 형식이 올바르지 않습니다.`);
    const key = cleanString(source.key, `캐릭터 ${index + 1} key`, 32);
    const name = cleanString(source.name, `캐릭터 ${index + 1} 이름`, 20);
    if (!KEY.test(key) || keys.has(key)) throw new Error('캐릭터 key는 영문 소문자로 시작하며 서로 달라야 합니다.');
    if (names.has(name)) throw new Error('캐릭터 이름은 서로 달라야 합니다.');
    keys.add(key); names.add(name);
    const gender = cleanString(source.gender, `${name} 성별`, 20);
    if (!GENDERS.has(gender)) throw new Error(`${name}의 성별 값이 올바르지 않습니다.`);
    const color = cleanString(source.color, `${name} 색상`, 7);
    if (!HEX_COLOR.test(color)) throw new Error(`${name}의 색상은 #RRGGBB 형식이어야 합니다.`);
    return {
      key, name, gender,
      role: cleanString(source.role, `${name} 역할`, 40),
      emoji: cleanString(source.emoji, `${name} 이모지`, 8), color,
      personality: cleanString(source.personality, `${name} 성격`, 120),
      speechStyle: cleanString(source.speechStyle, `${name} 말투`, 120),
      goal: cleanString(source.goal, `${name} 목표`, 120),
      secret: cleanString(source.secret, `${name} 비밀`, 120),
      emotion: cleanString(source.emotion, `${name} 초기 감정`, 80)
    };
  });
  if (!Array.isArray(input.relationships)) throw new Error('관계 목록 형식이 올바르지 않습니다.');
  if (input.relationships.length > 15) throw new Error('관계는 최대 15개까지 설정할 수 있습니다.');
  const pairs = new Set();
  const relationships = input.relationships.map((source, index) => {
    if (!source || typeof source !== 'object' || !Array.isArray(source.characterKeys) || source.characterKeys.length !== 2) throw new Error(`관계 ${index + 1} 형식이 올바르지 않습니다.`);
    const characterKeys = source.characterKeys.map((value) => cleanString(value, `관계 ${index + 1} 대상`, 32));
    if (characterKeys[0] === characterKeys[1] || characterKeys.some((key) => !keys.has(key))) throw new Error(`관계 ${index + 1} 대상이 올바르지 않습니다.`);
    const pair = [...characterKeys].sort().join(':');
    if (pairs.has(pair)) throw new Error('같은 캐릭터 관계가 중복되었습니다.');
    pairs.add(pair);
    if (!Number.isInteger(source.score) || source.score < 0 || source.score > 100) throw new Error(`관계 ${index + 1} 점수는 0~100 정수여야 합니다.`);
    return { characterKeys, label: cleanString(source.label, `관계 ${index + 1} 설명`, 120), score: source.score };
  });
  const missingItems = Array.isArray(input.missingItems) ? input.missingItems.slice(0, 6).map((item) => cleanString(item, '추가 확인 항목', 120)) : [];
  const sourceStory = input.story && typeof input.story === 'object' ? input.story : {};
  const story = {
    premise: cleanString(sourceStory.premise || world.description, '이야기 전제', 300),
    openingQuestion: cleanString(sourceStory.openingQuestion || '이 인물들은 첫 선택에서 무엇을 감수할 것인가?', '첫 미해결 질문', 240),
    coreTensions: (Array.isArray(sourceStory.coreTensions) ? sourceStory.coreTensions : [{ summary: world.description, involvedCharacterKeys: [...keys], pressure: 40 }]).slice(0, 5).map((item, index) => ({
      summary: cleanString(item?.summary, `핵심 긴장 ${index + 1}`, 240),
      involvedCharacterKeys: [...new Set((Array.isArray(item?.involvedCharacterKeys) ? item.involvedCharacterKeys : []).filter((key) => keys.has(key)))].slice(0, 6),
      pressure: Number.isInteger(item?.pressure) ? Math.max(0, Math.min(100, item.pressure)) : 40
    }))
  };
  if (!story.coreTensions.length) throw new Error('핵심 긴장이 최소 하나 필요합니다.');
  return { world, story, characters, relationships, missingItems };
}

function mapDraft(row, messages = []) {
  return {
    id: row.id, status: row.status, threadId: row.threadId, model: row.model, reasoningEffort: row.reasoningEffort,
    draft: Object.keys(row.draftData || {}).length ? row.draftData : emptyDraft(),
    createdProjectId: row.createdProjectId, createdAt: row.createdAt, updatedAt: row.updatedAt, messages
  };
}

const draftSelect = `SELECT id,status,thread_id AS "threadId",model,reasoning_effort AS "reasoningEffort",draft_data AS "draftData",
  created_project_id AS "createdProjectId",created_at AS "createdAt",updated_at AS "updatedAt" FROM world_creation_drafts`;

export async function listWorldDrafts(queryable) {
  return (await queryable.query(`${draftSelect} WHERE status='ACTIVE' ORDER BY updated_at DESC`)).rows.map((row) => mapDraft(row));
}

export async function getWorldDraft(queryable, draftId) {
  const row = (await queryable.query(`${draftSelect} WHERE id=$1`, [draftId])).rows[0];
  if (!row) return null;
  const messages = (await queryable.query(`SELECT role,content,sequence,created_at AS "createdAt" FROM world_creation_messages WHERE draft_id=$1 ORDER BY sequence`, [draftId])).rows;
  return mapDraft(row, messages);
}

export async function startWorldDraft(pool, sourceProjectId) {
  const settings = (await pool.query(`SELECT COALESCE(utility_model,default_model) AS model,utility_reasoning_effort AS effort FROM projects WHERE id=$1`, [sourceProjectId])).rows[0];
  if (!settings) throw new Error('Source project not found.');
  const row = (await pool.query(`INSERT INTO world_creation_drafts(source_project_id,model,reasoning_effort,draft_data) VALUES ($1,$2,$3,$4) RETURNING id`, [sourceProjectId, settings.model, settings.effort, JSON.stringify(emptyDraft())])).rows[0];
  return getWorldDraft(pool, row.id);
}

export async function converseWorldDraft(pool, draftId, userMessage, runId) {
  const message = cleanString(userMessage, '요청', 2000);
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query("SELECT pg_try_advisory_lock(hashtext('world-draft:' || $1::text)) AS locked", [draftId])).rows[0].locked;
    if (!locked) throw new Error('이 초안은 이미 응답을 생성하고 있습니다.');
    const current = await getWorldDraft(client, draftId);
    if (!current) throw new Error('월드 초안을 찾을 수 없습니다.');
    if (current.status !== 'ACTIVE') throw new Error('종료된 월드 초안입니다.');
    const result = await generateWorldDraft({ draft: current.draft, messages: current.messages, userMessage: message, threadId: current.threadId, model: current.model, reasoningEffort: current.reasoningEffort, runId });
    const draft = validateWorldDraft({ ...result.draft, missingItems: result.missingItems });
    await client.query('BEGIN');
    const sequence = Number((await client.query('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM world_creation_messages WHERE draft_id=$1', [draftId])).rows[0].next);
    await client.query(`INSERT INTO world_creation_messages(id,draft_id,sequence,role,content) VALUES ($1,$2,$3,'USER',$4),($5,$2,$6,'ASSISTANT',$7)`, [randomUUID(), draftId, sequence, message, randomUUID(), sequence + 1, result.reply]);
    await client.query(`UPDATE world_creation_drafts SET thread_id=$2,draft_data=$3,updated_at=NOW() WHERE id=$1`, [draftId, result.threadId, JSON.stringify(draft)]);
    await client.query('COMMIT');
    return getWorldDraft(client, draftId);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('world-draft:' || $1::text))", [draftId]);
    client.release();
  }
}

export async function saveWorldDraft(pool, draftId, input) {
  const draft = validateWorldDraft(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('world-draft:' || $1::text))", [draftId]);
    const result = await client.query(`UPDATE world_creation_drafts SET draft_data=$2,updated_at=NOW() WHERE id=$1 AND status='ACTIVE'`, [draftId, JSON.stringify(draft)]);
    if (!result.rowCount) throw new Error('작성 중인 월드 초안을 찾을 수 없습니다.');
    await client.query('COMMIT');
    return getWorldDraft(client, draftId);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function createWorldFromDraft(pool, draftId) {
  const client = await pool.connect();
  let threadId = null;
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('world-draft:' || $1::text))", [draftId]);
    const row = (await client.query(`SELECT d.*,p.default_model,p.default_reasoning_effort,p.director_model,p.director_reasoning_effort,p.utility_model,p.utility_reasoning_effort,p.attribute_schema
      FROM world_creation_drafts d JOIN projects p ON p.id=d.source_project_id WHERE d.id=$1 FOR UPDATE OF d`, [draftId])).rows[0];
    if (!row || row.status !== 'ACTIVE') throw new Error('작성 중인 월드 초안을 찾을 수 없습니다.');
    const draft = validateWorldDraft(row.draft_data);
    const projectId = randomUUID(); const sceneId = randomUUID(); const ids = new Map();
    const world = draft.world;
    const initialStoryState = { version: 1, arcPhase: 'setup', tension: Math.round(draft.story.coreTensions.reduce((sum, item) => sum + item.pressure, 0) / draft.story.coreTensions.length), pacing: 'steady', activeTensions: [], openQuestions: [], recentBeats: [], lastDirectorSequence: 0 };
    for (const [index, character] of draft.characters.entries()) {
      const id = randomUUID(); ids.set(character.key, id);
      const profile = { name: character.name, role: character.role, gender: character.gender, personality: character.personality, speechStyle: character.speechStyle, goal: character.goal, secret: character.secret, emotion: character.emotion };
      const currentState = { currentGoal: character.goal, internalConflict: '', beliefs: [], commitments: [], developmentNotes: [], lastChangedSequence: 0 };
      character.currentState = currentState;
      character.generatedId = id;
    }
    initialStoryState.activeTensions = draft.story.coreTensions.map((item) => ({ id: randomUUID(), summary: item.summary, involvedCharacterIds: item.involvedCharacterKeys.map((key) => ids.get(key)).filter(Boolean), pressure: item.pressure, introducedAtSequence: 0 }));
    initialStoryState.openQuestions = [{ id: randomUUID(), text: draft.story.openingQuestion, involvedCharacterIds: [...ids.values()], urgency: 45, introducedAtSequence: 0 }];
    const initialDramaticState = { objective: draft.story.openingQuestion, stakes: draft.story.premise, dilemma: draft.story.coreTensions[0].summary, beatType: 'choice', targetTension: initialStoryState.tension, participantIds: [...ids.values()] };
    await client.query(`INSERT INTO projects(id,title,location,mood,scene_time,description,rules,public_direction,private_director_state,default_model,default_reasoning_effort,director_model,director_reasoning_effort,utility_model,utility_reasoning_effort,attribute_schema,next_event_sequence,initial_world,drama_intensity,story_state)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'인물들이 현재 상황에서 자연스럽게 이야기를 시작합니다.','',$8,$9,$10,$11,$12,$13,$14,1,$15,$16,$17)`,
    [projectId,world.title,world.location,world.mood,world.time,world.description,world.rules,row.default_model,row.default_reasoning_effort,row.director_model,row.director_reasoning_effort,row.utility_model,row.utility_reasoning_effort,row.attribute_schema,JSON.stringify({ ...world, storyState: initialStoryState, dramaticState: initialDramaticState }),world.dramaIntensity,JSON.stringify(initialStoryState)]);
    for (const [index, character] of draft.characters.entries()) await client.query(`INSERT INTO characters(id,project_id,name,role,gender,emoji,color,personality,speech_style,goal,secret,emotion,sort_order,initial_profile,current_state)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [character.generatedId,projectId,character.name,character.role,character.gender,character.emoji,character.color,character.personality,character.speechStyle,character.goal,character.secret,character.emotion,index,JSON.stringify({ name: character.name, role: character.role, gender: character.gender, personality: character.personality, speechStyle: character.speechStyle, goal: character.goal, secret: character.secret, emotion: character.emotion }),JSON.stringify(character.currentState)]);
    for (const relationship of draft.relationships) {
      const [first, second] = relationship.characterKeys.map((key) => ids.get(key));
      for (const [from, to] of [[first,second],[second,first]]) await client.query(`INSERT INTO relationships(id,project_id,from_character_id,to_character_id,label,score,initial_label,initial_score) VALUES ($1,$2,$3,$4,$5,$6,$5,$6)`, [randomUUID(),projectId,from,to,relationship.label,relationship.score]);
    }
    await client.query(`INSERT INTO scenes(id,project_id,scene_number,location,mood,scene_time,description,summary,public_direction,private_director_state,presentation_mode,dramatic_state)
      VALUES ($1,$2,1,$3,$4,$5,$6,$6,'인물들이 현재 상황에서 자연스럽게 이야기를 시작합니다.','',$7,$8)`, [sceneId,projectId,world.location,world.mood,world.time,world.description,world.presentationMode,JSON.stringify(initialDramaticState)]);
    await client.query(`INSERT INTO scene_participants(scene_id,character_id,joined_sequence) SELECT $1,id,0 FROM characters WHERE project_id=$2`, [sceneId, projectId]);
    threadId = row.thread_id;
    await client.query(`UPDATE world_creation_drafts SET status='CREATED',created_project_id=$2,thread_id=NULL,updated_at=NOW() WHERE id=$1`, [draftId, projectId]);
    await client.query('COMMIT');
    if (threadId) void cleanupCodexThread(threadId);
    return projectId;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function cancelWorldDraft(pool, draftId) {
  const client = await pool.connect();
  let threadId = null;
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('world-draft:' || $1::text))", [draftId]);
    const row = (await client.query(`SELECT thread_id FROM world_creation_drafts WHERE id=$1 AND status='ACTIVE' FOR UPDATE`, [draftId])).rows[0];
    if (!row) throw new Error('작성 중인 월드 초안을 찾을 수 없습니다.');
    threadId = row.thread_id;
    await client.query(`UPDATE world_creation_drafts SET status='CANCELLED',thread_id=NULL,updated_at=NOW() WHERE id=$1`, [draftId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  if (threadId) void cleanupCodexThread(threadId);
}

export { emptyDraft };
