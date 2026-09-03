import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { resetPlaythrough } from '../project-lifecycle.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const projectId = '00000000-0000-4000-8000-000000000001';
const characterIds = ['00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000013'];
const initialEntries = [
  [characterIds[0], '그 책은 건드리지 않는 편이 좋겠습니다. 지금은… 너무 불안정해 보여요.', '세라가 낡은 마법서를 조용히 덮는다.'],
  [characterIds[1], '왜 그렇게까지 막는 거지? 그냥 오래된 책일 뿐이잖아.', '루카는 세라의 손과 책 표지를 번갈아 바라본다.'],
  [characterIds[2], '잠깐만요. 이 표식, 지난주에 사라진 책에도 있었어요.', '미나가 떨리는 손으로 빛나는 문양을 가리킨다.']
];
const storyState = { version: 1, arcPhase: 'setup', tension: 55, pacing: 'steady', activeTensions: [{ id: 'forbidden-book', summary: '세라는 금서의 위험을 알지만 연구 사실을 숨기고, 루카는 그녀를 믿고 싶으면서도 의심한다.', involvedCharacterIds: characterIds, pressure: 60, introducedAtSequence: 0 }], openQuestions: [{ id: 'missing-book', text: '사라진 금서와 빛나는 표식은 누구의 계획인가?', involvedCharacterIds: characterIds, urgency: 55, introducedAtSequence: 0 }], recentBeats: [], lastDirectorSequence: 0 };
const dramaticState = { objective: '빛나는 금서를 지금 조사할지 봉인할지 결정한다.', stakes: '교내 안전과 세라에 대한 신뢰', dilemma: '위험을 감수하고 단서를 확인할지 세라의 경고를 따를지', beatType: 'choice', targetTension: 60, participantIds: characterIds };

try {
  await resetPlaythrough(pool, projectId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sceneId = (await client.query("SELECT id FROM scenes WHERE project_id=$1 AND status='active'", [projectId])).rows[0].id;
    await client.query('UPDATE projects SET story_state=$2,drama_intensity=\'balanced\' WHERE id=$1', [projectId, JSON.stringify(storyState)]);
    await client.query('UPDATE scenes SET dramatic_state=$2 WHERE id=$1', [sceneId, JSON.stringify(dramaticState)]);
    for (const [index, [characterId, dialogue, action]] of initialEntries.entries()) {
      const entryId = randomUUID(); const sequence = index + 1;
      await client.query(`INSERT INTO scene_entries(id,project_id,scene_id,entry_type,character_id,dialogue,action,sort_order,world_sequence,actor_type,event_kind,payload)
        VALUES ($1,$2,$3,'message',$4,$5,$6,$7,$8,'CHARACTER','CHARACTER_RESPONSE',$9)`, [entryId, projectId, sceneId, characterId, dialogue, action, index, sequence, JSON.stringify({ dialogue, action })]);
      for (const recipientId of characterIds) await client.query('INSERT INTO scene_entry_recipients(entry_id,character_id) VALUES ($1,$2)', [entryId, recipientId]);
    }
    await client.query('UPDATE projects SET next_event_sequence=4,updated_at=NOW() WHERE id=$1', [projectId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  console.log('Demo scene reset.');
} finally { await pool.end(); }
