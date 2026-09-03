import { randomUUID } from 'node:crypto';
import { cleanupCodexThread, generateStoryRepair } from './codex-client.js';
import { getDirectorContext, getStoryState, updateDirectorThread } from './story-engine.js';
import { cleanCharacterState, cleanDramaticState, cleanStoryState } from './story-dynamics.js';

const selectProposal = `SELECT id,project_id AS "projectId",source_world_sequence AS "sourceWorldSequence",proposal,status,
  created_at AS "createdAt",decided_at AS "decidedAt" FROM story_repair_proposals`;

export async function getPendingStoryRepair(queryable, projectId) {
  return (await queryable.query(`${selectProposal} WHERE project_id=$1 AND status='PENDING' ORDER BY created_at DESC LIMIT 1`, [projectId])).rows[0] || null;
}

function validateRepair(result, state, memories) {
  const characterIds = state.characters.map((character) => character.id);
  const allowed = new Set(characterIds);
  const stateIds = result.characterStates.map((item) => item.characterId);
  if (stateIds.length !== characterIds.length || new Set(stateIds).size !== characterIds.length || stateIds.some((id) => !allowed.has(id))) throw new Error('보정안의 캐릭터 상태 범위가 현재 월드와 일치하지 않습니다.');
  const relationKeys = new Set(state.relationships.map((item) => `${item.from}:${item.to}`));
  const proposedKeys = result.relationships.map((item) => `${item.from}:${item.to}`);
  if (proposedKeys.length !== relationKeys.size || new Set(proposedKeys).size !== relationKeys.size || proposedKeys.some((key) => !relationKeys.has(key))) throw new Error('보정안의 관계 범위가 현재 월드와 일치하지 않습니다.');
  for (const relationship of result.relationships) {
    const before = state.relationships.find((item) => item.from === relationship.from && item.to === relationship.to);
    if (!before || Math.abs(Number(relationship.score) - Number(before.score)) > 20) throw new Error('관계 점수 보정 폭은 20을 넘을 수 없습니다.');
    relationship.label = String(relationship.label || '').trim().slice(0, 120);
    if (!relationship.label) throw new Error('관계 설명이 비어 있습니다.');
  }
  result.participantIds = [...new Set(result.participantIds)].filter((id) => allowed.has(id));
  if (!result.participantIds.length) throw new Error('현재 장면 참여자가 최소 한 명 필요합니다.');
  const memoryIds = new Set(memories.map((memory) => memory.id));
  const suppliedDecisions = new Map((Array.isArray(result.memoryDecisions) ? result.memoryDecisions : []).filter((item) => memoryIds.has(item.memoryId)).map((item) => [item.memoryId, item.action]));
  result.memoryDecisions = memories.map((memory) => ({ memoryId: memory.id, action: suppliedDecisions.get(memory.id) === 'ARCHIVE' ? 'ARCHIVE' : 'KEEP' }));
  const memoryOwner = new Map(memories.map((memory) => [memory.id, memory.characterId]));
  for (const characterId of characterIds) {
    const keepCount = result.memoryDecisions.filter((item) => item.action === 'KEEP' && memoryOwner.get(item.memoryId) === characterId).length;
    if (keepCount > 12) throw new Error('캐릭터별 활성 기억은 12개를 넘을 수 없습니다.');
  }
  result.storyState = cleanStoryState(result.storyState, characterIds, state.storyState);
  result.sceneState = cleanDramaticState({ ...result.sceneState, participantIds: result.participantIds }, characterIds, state.dramaticState);
  result.characterStates = result.characterStates.map((item) => ({ characterId: item.characterId, state: cleanCharacterState({ ...item.state, lastChangedSequence: state.latestSceneSequence }, state.characters.find((character) => character.id === item.characterId)?.goal) }));
  result.summary = String(result.summary || '').trim().slice(0, 1200);
  return result;
}

export async function createStoryRepairProposal(pool, projectId, runId) {
  const existing = await getPendingStoryRepair(pool, projectId);
  if (existing) return existing;
  const state = await getStoryState(pool, projectId);
  if (!state) throw new Error('Project not found.');
  const director = await getDirectorContext(pool, projectId);
  const scenes = (await pool.query(`SELECT scene_number AS "sceneNumber",location,scene_time AS time,summary FROM scenes WHERE project_id=$1 ORDER BY scene_number`, [projectId])).rows;
  const recentEntries = (await pool.query(`SELECT s.scene_number AS "sceneNumber",e.world_sequence AS sequence,e.entry_type AS type,e.character_id AS "characterId",e.dialogue,e.action,e.event_text AS "eventText",e.event_type AS "eventType"
    FROM scene_entries e JOIN scenes s ON s.id=e.scene_id WHERE e.project_id=$1 ORDER BY e.world_sequence DESC LIMIT 20`, [projectId])).rows.reverse();
  const sceneHistory = { scenes, recentEntries };
  const memories = (await pool.query(`SELECT id,character_id AS "characterId",memory_text AS "memoryText",emotion,importance,created_at AS "createdAt"
    FROM character_memories WHERE project_id=$1 AND archived_at IS NULL ORDER BY character_id,importance DESC,created_at DESC`, [projectId])).rows;
  const generated = validateRepair(await generateStoryRepair({ state, sceneHistory, memories }, runId, director), state, memories);
  const runtime = { threadId: generated.threadId, threadUsage: generated.threadUsage, previousThreadId: generated.previousThreadId };
  delete generated.threadId;
  delete generated.threadReused;
  delete generated.threadUsage;
  delete generated.timeToFirstTokenMs;
  delete generated.threadRolledOver;
  delete generated.previousThreadId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [projectId]);
    const currentSequence = Number((await client.query('SELECT COALESCE(MAX(world_sequence),0) AS sequence FROM scene_entries WHERE project_id=$1', [projectId])).rows[0].sequence);
    if (currentSequence !== state.latestSceneSequence) throw new Error('진행 기록이 진단 중 변경되었습니다. 다시 진단해 주세요.');
    await client.query("UPDATE story_repair_proposals SET status='STALE',decided_at=NOW() WHERE project_id=$1 AND status='PENDING'", [projectId]);
    const id = randomUUID();
    await client.query(`INSERT INTO story_repair_proposals(id,project_id,source_world_sequence,proposal) VALUES ($1,$2,$3,$4)`, [id, projectId, currentSequence, JSON.stringify(generated)]);
    await updateDirectorThread(client, projectId, runtime, currentSequence);
    await client.query('COMMIT');
    await cleanupCodexThread(runtime.previousThreadId);
    return (await client.query(`${selectProposal} WHERE id=$1`, [id])).rows[0];
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function decideStoryRepair(pool, projectId, proposalId, decision) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [projectId]);
    const row = (await client.query(`${selectProposal} WHERE id=$1 AND project_id=$2 FOR UPDATE`, [proposalId, projectId])).rows[0];
    if (!row || row.status !== 'PENDING') throw new Error('대기 중인 이야기 보정안을 찾을 수 없습니다.');
    if (decision === 'REJECT') {
      await client.query("UPDATE story_repair_proposals SET status='REJECTED',decided_at=NOW() WHERE id=$1", [proposalId]);
      await client.query('COMMIT');
      return { applied: false, proposalId };
    }
    const sequence = Number((await client.query('SELECT COALESCE(MAX(world_sequence),0) AS sequence FROM scene_entries WHERE project_id=$1', [projectId])).rows[0].sequence);
    if (sequence !== Number(row.sourceWorldSequence)) {
      await client.query("UPDATE story_repair_proposals SET status='STALE',decided_at=NOW() WHERE id=$1", [proposalId]);
      await client.query('COMMIT');
      throw new Error('진행 기록이 바뀌어 보정안이 만료되었습니다. 다시 진단해 주세요.');
    }
    const proposal = row.proposal;
    const state = await getStoryState(client, projectId);
    await client.query('UPDATE projects SET story_state=$2,updated_at=NOW() WHERE id=$1', [projectId, JSON.stringify(proposal.storyState)]);
    await client.query('UPDATE scenes SET dramatic_state=$2,public_direction=COALESCE(NULLIF($3,\'\'),public_direction),updated_at=NOW() WHERE id=$1', [state.sceneId, JSON.stringify(proposal.sceneState), proposal.sceneState.objective]);
    for (const item of proposal.characterStates) {
      const before = state.characters.find((character) => character.id === item.characterId)?.currentState || {};
      await client.query('UPDATE characters SET current_state=$2,updated_at=NOW() WHERE id=$1 AND project_id=$3', [item.characterId, JSON.stringify(item.state), projectId]);
      await client.query(`INSERT INTO character_change_proposals(project_id,character_id,change_type,severity,patch,status,decided_at) VALUES ($1,$2,'STORY_REPAIR','MINOR',$3,'APPLIED',NOW())`, [projectId, item.characterId, JSON.stringify({ before, after: item.state, repairProposalId: proposalId })]);
    }
    for (const relationship of proposal.relationships) await client.query('UPDATE relationships SET label=$4,score=$5,updated_at=NOW() WHERE project_id=$1 AND from_character_id=$2 AND to_character_id=$3', [projectId, relationship.from, relationship.to, relationship.label, relationship.score]);
    const participantIds = new Set(proposal.participantIds);
    await client.query(`UPDATE scene_participants SET left_sequence=$2 WHERE scene_id=$1 AND left_sequence IS NULL AND NOT (character_id=ANY($3::uuid[]))`, [state.sceneId, sequence, [...participantIds]]);
    for (const characterId of participantIds) await client.query(`INSERT INTO scene_participants(scene_id,character_id,joined_sequence) SELECT $1,$2,$3 WHERE NOT EXISTS (SELECT 1 FROM scene_participants WHERE scene_id=$1 AND character_id=$2 AND left_sequence IS NULL)`, [state.sceneId, characterId, sequence]);
    const archived = proposal.memoryDecisions.filter((item) => item.action === 'ARCHIVE').map((item) => item.memoryId);
    if (archived.length) await client.query('UPDATE character_memories SET archived_at=NOW() WHERE project_id=$1 AND id=ANY($2::uuid[])', [projectId, archived]);
    await client.query("UPDATE story_repair_proposals SET status='APPLIED',decided_at=NOW() WHERE id=$1", [proposalId]);
    await client.query('COMMIT');
    return { applied: true, proposalId, state: await getStoryState(client, projectId) };
  } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
}
