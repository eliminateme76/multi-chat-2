import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const projectId = '00000000-0000-4000-8000-000000000001';
const initialEntries = [
  ['00000000-0000-4000-8000-000000000011', '그 책은 건드리지 않는 편이 좋겠습니다. 지금은… 너무 불안정해 보여요.', '세라가 낡은 마법서를 조용히 덮는다.'],
  ['00000000-0000-4000-8000-000000000012', '왜 그렇게까지 막는 거지? 그냥 오래된 책일 뿐이잖아.', '루카는 세라의 손과 책 표지를 번갈아 바라본다.'],
  ['00000000-0000-4000-8000-000000000013', '잠깐만요. 이 표식, 지난주에 사라진 책에도 있었어요.', '미나가 떨리는 손으로 빛나는 문양을 가리킨다.']
];
const emotions = [['00000000-0000-4000-8000-000000000011', '경계'], ['00000000-0000-4000-8000-000000000012', '의심'], ['00000000-0000-4000-8000-000000000013', '호기심']];

try {
  await pool.query('BEGIN');
  await pool.query('DELETE FROM scene_entries WHERE project_id=$1', [projectId]);
  for (const [sortOrder, [characterId, dialogue, action]] of initialEntries.entries()) await pool.query('INSERT INTO scene_entries (id,project_id,entry_type,character_id,dialogue,action,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), projectId, 'message', characterId, dialogue, action, sortOrder]);
  for (const [characterId, emotion] of emotions) await pool.query('UPDATE characters SET emotion=$2,updated_at=NOW() WHERE id=$1', [characterId, emotion]);
  await pool.query("UPDATE projects SET scene_number=1,turn_number=0,description='늦은 밤. 폭풍우가 창을 두드리고, 오래된 마법서가 희미하게 빛난다.',director_note='세라의 비밀을 둘러싼 긴장을 유지하세요. 루카에게는 아직 확실한 증거가 없습니다.',updated_at=NOW() WHERE id=$1", [projectId]);
  await pool.query('COMMIT');
  console.log('Demo scene reset.');
} catch (error) {
  await pool.query('ROLLBACK');
  throw error;
} finally { await pool.end(); }