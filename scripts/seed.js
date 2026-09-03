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
const storyState = { version: 1, arcPhase: 'setup', tension: 55, pacing: 'steady', activeTensions: [{ id: 'forbidden-book', summary: '세라는 금서의 위험을 알지만 연구 사실을 숨기고, 루카는 그녀를 믿고 싶으면서도 의심한다.', involvedCharacterIds: cast.map((item) => item[0]), pressure: 60, introducedAtSequence: 0 }], openQuestions: [{ id: 'missing-book', text: '사라진 금서와 빛나는 표식은 누구의 계획인가?', involvedCharacterIds: cast.map((item) => item[0]), urgency: 55, introducedAtSequence: 0 }], recentBeats: [], lastDirectorSequence: 0 };
const dramaticState = { objective: '빛나는 금서를 지금 조사할지 봉인할지 결정한다.', stakes: '교내 안전과 세라에 대한 신뢰', dilemma: '위험을 감수하고 단서를 확인할지 세라의 경고를 따를지', beatType: 'choice', targetTension: 60, participantIds: cast.map((item) => item[0]) };
try {
  const exists = await pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
  if (exists.rowCount) { console.log('Demo project already exists.'); process.exit(0); }
  await pool.query('BEGIN');
  await pool.query(`INSERT INTO projects (id,title,location,mood,scene_time,description,rules,scene_number,turn_number,director_note,public_direction,private_director_state,story_state,next_event_sequence,initial_world) VALUES ($1,$2,$3,$4,$5,$6,$7,1,0,$8,$9,$8,$10,4,$11)`, [projectId, '별빛 마도학원', '중앙 도서관, 금서 보관실 앞', '긴장 · 미스터리', '폭풍우 치는 밤', '늦은 밤. 폭풍우가 창을 두드리고, 오래된 마법서가 희미하게 빛난다.', '고위 공격 마법은 교내에서 금지된다, 마법 계약은 쉽게 파기할 수 없다', '세라의 비밀을 둘러싼 긴장을 유지하세요. 루카에게는 아직 확실한 증거가 없습니다.', '공개된 단서를 바탕으로 금서 보관실의 긴장을 이어가세요.', JSON.stringify(storyState), JSON.stringify({ title: '별빛 마도학원', location: '중앙 도서관, 금서 보관실 앞', mood: '긴장 · 미스터리', time: '폭풍우 치는 밤', description: '늦은 밤. 폭풍우가 창을 두드리고, 오래된 마법서가 희미하게 빛난다.', rules: '고위 공격 마법은 교내에서 금지된다, 마법 계약은 쉽게 파기할 수 없다', presentationMode: 'scene', dramaIntensity: 'balanced', storyState, dramaticState })]);
  for (const [index, character] of cast.entries()) await pool.query(`INSERT INTO characters (id,project_id,name,role,emoji,color,personality,speech_style,goal,secret,emotion,sort_order,initial_profile,current_state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [character[0], projectId, ...character.slice(1), index, JSON.stringify({ name: character[1], role: character[2], personality: character[5], speechStyle: character[6], goal: character[7], secret: character[8], emotion: character[9] }), JSON.stringify({ currentGoal: character[7], internalConflict: '', beliefs: [], commitments: [], developmentNotes: [], lastChangedSequence: 0 })]);
  for (const [from, to, label, score] of [[cast[0][0], cast[1][0], '라이벌 · 불완전한 신뢰', 44], [cast[0][0], cast[2][0], '보호하고 싶은 동료', 68], [cast[1][0], cast[2][0], '오래된 친구', 77]]) await pool.query('INSERT INTO relationships (id,project_id,from_character_id,to_character_id,label,score) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), projectId, from, to, label, score]);
  await pool.query(`INSERT INTO scenes (id,project_id,scene_number,location,mood,scene_time,description,summary,public_direction,private_director_state,dramatic_state) VALUES ($1,$2,1,$3,$4,$5,$6,$6,$7,$8,$9)`, [sceneId, projectId, '중앙 도서관, 금서 보관실 앞', '긴장 · 미스터리', '폭풍우 치는 밤', '늦은 밤. 폭풍우가 창을 두드리고, 오래된 마법서가 희미하게 빛난다.', '공개된 단서를 바탕으로 금서 보관실의 긴장을 이어가세요.', '세라의 비밀을 둘러싼 긴장을 유지하세요. 루카에게는 아직 확실한 증거가 없습니다.', JSON.stringify(dramaticState)]);
  for (const id of cast.map((item) => item[0])) await pool.query('INSERT INTO scene_participants(scene_id,character_id,joined_sequence) VALUES ($1,$2,0)', [sceneId, id]);
  for (const [order, characterId, dialogue, action] of [[0,cast[0][0],'그 책은 건드리지 않는 편이 좋겠습니다. 지금은… 너무 불안정해 보여요.','세라가 낡은 마법서를 조용히 덮는다.'],[1,cast[1][0],'왜 그렇게까지 막는 거지? 그냥 오래된 책일 뿐이잖아.','루카는 세라의 손과 책 표지를 번갈아 바라본다.'],[2,cast[2][0],'잠깐만요. 이 표식, 지난주에 사라진 책에도 있었어요.','미나가 떨리는 손으로 빛나는 문양을 가리킨다.']]) {
    const entryId = randomUUID();
    await pool.query(`INSERT INTO scene_entries (id,project_id,scene_id,entry_type,character_id,dialogue,action,sort_order,world_sequence,actor_type,event_kind,payload) VALUES ($1,$2,$3,'message',$4,$5,$6,$7,$8,'CHARACTER','CHARACTER_RESPONSE',$9)`, [entryId, projectId, sceneId, characterId, dialogue, action, order, order + 1, JSON.stringify({ dialogue, action })]);
    for (const id of cast.map((item) => item[0])) await pool.query('INSERT INTO scene_entry_recipients(entry_id,character_id) VALUES ($1,$2)', [entryId, id]);
  }
  await pool.query('COMMIT'); console.log('Demo project seeded.');
} catch (error) { await pool.query('ROLLBACK'); throw error; } finally { await pool.end(); }
