import assert from 'node:assert/strict';
import { buildCharacterTurnPrompt } from '../context-builder.js';
import { applyCharacterStatePatch, applyStoryStatePatch, cleanDramaticState } from '../story-dynamics.js';

const ids = ['character-a', 'character-b', 'character-c'];

const characterState = applyCharacterStatePatch({
  currentGoal: '열쇠를 찾는다', internalConflict: '친구를 믿어도 될지 망설인다',
  beliefs: ['문은 잠겨 있다', '경비는 정직하다'], commitments: ['해 뜨기 전에 돌아온다'], developmentNotes: ['처음으로 도움을 청했다'], lastChangedSequence: 7
}, {
  setCurrentGoal: null, setInternalConflict: '친구에게 사실을 말할지 망설인다',
  addBeliefs: ['창문은 열려 있다'], removeBeliefs: ['문은 잠겨 있다'],
  addCommitments: [], removeCommitments: [], appendDevelopmentNotes: ['경비의 거짓말을 알아챘다']
});
assert.equal(characterState.currentGoal, '열쇠를 찾는다');
assert.equal(characterState.internalConflict, '친구에게 사실을 말할지 망설인다');
assert.deepEqual(characterState.beliefs, ['경비는 정직하다', '창문은 열려 있다']);
assert.equal(characterState.lastChangedSequence, 7);

const storyState = applyStoryStatePatch({
  arcPhase: 'rising', tension: 55, pacing: 'steady',
  activeTensions: [{ id: 'lock', summary: '잠긴 문', involvedCharacterIds: [ids[0]], pressure: 50, introducedAtSequence: 2 }],
  openQuestions: [{ id: 'who', text: '누가 열쇠를 숨겼나?', involvedCharacterIds: ids.slice(0, 2), urgency: 60, introducedAtSequence: 3 }],
  recentBeats: [], lastDirectorSequence: 4
}, {
  arcPhase: null, tension: 58, pacing: null,
  upsertActiveTensions: [{ id: 'witness', summary: '목격자의 침묵', involvedCharacterIds: [ids[1]], pressure: 45, introducedAtSequence: 8 }],
  removeActiveTensionIds: ['lock'], upsertOpenQuestions: [], removeOpenQuestionIds: [],
  recentBeat: { type: 'discovery', summary: '열린 창문을 발견했다.' }
}, ids, 8);
assert.equal(storyState.arcPhase, 'rising');
assert.equal(storyState.tension, 58);
assert.deepEqual(storyState.activeTensions.map((item) => item.id), ['witness']);
assert.equal(storyState.recentBeats.at(-1).sequence, 8);

const queue = cleanDramaticState({ participantIds: ids, plannedResponderIds: [ids[1], ids[2]], planResponderIds: [ids[0], ids[1]], planStartedSequence: 12, responsesConsumed: 1, planAction: 'CONTINUE', planRationale: '두 인물의 반응을 이어 본다.', planOperationId: 'operation-1' }, ids);
assert.deepEqual(queue.plannedResponderIds, [ids[1], ids[2]]);
assert.equal(queue.planStartedSequence, 12);
assert.equal(queue.responsesConsumed, 1);
assert.deepEqual(queue.planResponderIds, [ids[0], ids[1]]);
assert.equal(queue.planRationale, '두 인물의 반응을 이어 본다.');

const prompt = buildCharacterTurnPrompt({
  character: { id: ids[0], name: '가람', role: '탐정', gender: '여성', personality: '신중함', speechStyle: '짧은 존댓말', goal: '진실 찾기', secret: '없음', emotion: '집중', currentState: {} },
  state: { world: { title: '시험 세계', location: '서재', time: '밤', mood: '고요', description: '문을 조사한다.', rules: '' }, sceneSummary: '', publicDirection: '', presentationMode: 'scene', storyStatus: {}, dramaticState: {}, relationships: [], characters: [], logs: [{ type: 'event', eventType: '비공개', text: '절대 노출되면 안 됨' }] },
  recentVisibleEvents: [{ type: 'event', eventType: '발견', eventText: '창문이 열려 있다.' }]
});
assert.match(prompt, /창문이 열려 있다/);
assert.doesNotMatch(prompt, /절대 노출되면 안 됨/);

console.log('Latency logic verification passed.');
