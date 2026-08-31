import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const { Pool } = pg; const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const projectId = '00000000-0000-4000-8000-000000000001';
const sceneId = '00000000-0000-4000-8000-000000000002';
const cast = [
  ['00000000-0000-4000-8000-000000000011', '세라', '견습 마녀', '✦', '#7663ca', '냉정함, 책임감, 다정함을 숨김', '짧고 단정한 존댓말을 사용한다.', '실종된 스승의 흔적을 찾는다.', '금지된 시간 마법을 연구하고 있다.', '경계'],
  ['00000000-0000-4000-8000-000000000012', '루카', '마법 기사 견습생', '⚔', '#d47587', '정의감, 직설적임, 충성심', '솔직하고 힘 있는 반말을 사용한다.', '학교 안의 위험을 막는다.', '세라를 의심하면서도 믿고 싶어 한다.', '의심'],
  ['00000000-0000-4000-8000-000000000013', '미나', '도서관 사서 견습생', '☾', '#b8874b', '호기심, 낙천적임, 관찰력', '부드럽고 호기심 많은 말투를 사용한다.', '사라진 금서의 행방을 찾는다.', '누군가가 남긴 암호를 해독 중이다.', '호기심']
];
try {
  const exists = await pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
  if (exists.rowCount) { console.log('Demo project already exists.'); process.exit(0); }
  await pool.query('BEGIN');
  await pool.query(`INSERT INTO projects (id,title,location,mood,scene_time,description,rules,scene_number,turn_number,director_note,public_direction,private_director_state) VALUES ($1,$2,$3,$4,$5,$6,$7,1,0,$8,$9,$8)`, [projectId, '별빛 마도학원', '중앙 도서관, 금서 보관실 앞', '긴장 · 미스터리', '폭풍우 치는 밤', '늦은 밤. 폭풍우가 창을 두드리고, 오래된 마법서가 희미하게 빛난다.', '고위 공격 마법은 교내에서 금지된다, 마법 계약은 쉽게 파기할 수 없다', '세라의 비밀을 둘러싼 긴장을 유지하세요. 루카에게는 아직 확실한 증거가 없습니다.', '공개된 단서를 바탕으로 금서 보관실의 긴장을 이어가세요.']);
  for (const [index, character] of cast.entries()) await pool.query(`INSERT INTO characters (id,project_id,name,role,emoji,color,personality,speech_style,goal,secret,emotion,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [character[0], projectId, ...character.slice(1), index]);
  for (const [from, to, label, score] of [[cast[0][0], cast[1][0], '라이벌 · 불완전한 신뢰', 44], [cast[0][0], cast[2][0], '보호하고 싶은 동료', 68], [cast[1][0], cast[2][0], '오래된 친구', 77]]) await pool.query('INSERT INTO relationships (id,project_id,from_character_id,to_character_id,label,score) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), projectId, from, to, label, score]);
  await pool.query(`INSERT INTO scenes (id,project_id,scene_number,location,mood,scene_time,description,summary,public_direction,private_director_state) VALUES ($1,$2,1,$3,$4,$5,$6,$6,$7,$8)`, [sceneId, projectId, '중앙 도서관, 금서 보관실 앞', '긴장 · 미스터리', '폭풍우 치는 밤', '늦은 밤. 폭풍우가 창을 두드리고, 오래된 마법서가 희미하게 빛난다.', '공개된 단서를 바탕으로 금서 보관실의 긴장을 이어가세요.', '세라의 비밀을 둘러싼 긴장을 유지하세요. 루카에게는 아직 확실한 증거가 없습니다.']);
  for (const [order, characterId, dialogue, action] of [[0,cast[0][0],'그 책은 건드리지 않는 편이 좋겠습니다. 지금은… 너무 불안정해 보여요.','세라가 낡은 마법서를 조용히 덮는다.'],[1,cast[1][0],'왜 그렇게까지 막는 거지? 그냥 오래된 책일 뿐이잖아.','루카는 세라의 손과 책 표지를 번갈아 바라본다.'],[2,cast[2][0],'잠깐만요. 이 표식, 지난주에 사라진 책에도 있었어요.','미나가 떨리는 손으로 빛나는 문양을 가리킨다.']]) await pool.query('INSERT INTO scene_entries (id,project_id,scene_id,entry_type,character_id,dialogue,action,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), projectId, sceneId, 'message', characterId, dialogue, action, order]);
  await pool.query('COMMIT'); console.log('Demo project seeded.');
} catch (error) { await pool.query('ROLLBACK'); throw error; } finally { await pool.end(); }
