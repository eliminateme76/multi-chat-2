import assert from 'node:assert/strict';
import { buildCharacterTurnPrompt, buildDirectorProgressionPrompt } from '../context-builder.js';
import { applyCharacterStatePatch, applyStoryStatePatch, cleanDramaticState, findPendingWorldAttempt, routeCharacterInteraction } from '../story-dynamics.js';

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

const migratedWorldState = cleanDramaticState({ beatIntent: 'choice', outcomeConstraint: 'qualified_success', pressureSource: '문은 열렸지만 경보가 울렸다.', reliefReason: '' }, ids);
assert.equal(migratedWorldState.worldPhase, 'choice');
assert.equal(migratedWorldState.lastWorldOutcome, 'qualified_success');
assert.equal(migratedWorldState.worldPressure, '문은 열렸지만 경보가 울렸다.');
const attempt = { type: 'message', worldSequence: 9, payload: { actionScope: 'WORLD_ATTEMPT' }, action: '잠긴 문을 밀어 본다.' };
assert.equal(findPendingWorldAttempt([attempt]), attempt);
assert.equal(findPendingWorldAttempt([attempt, { type: 'event', actorType: 'DIRECTOR', worldSequence: 10 }]), null);
const interaction = routeCharacterInteraction(queue, ids, { sourceName: '가람', targetId: ids[2], targetName: '나래', sequence: 14 });
assert.deepEqual(interaction.plannedResponderIds, [ids[2]]);
assert.deepEqual(interaction.planResponderIds, [ids[2]]);
assert.equal(interaction.planAction, 'CHARACTER_INTERACTION');
assert.equal(interaction.responsesConsumed, 0);
assert.equal(interaction.planStartedSequence, 14);

const prompt = buildCharacterTurnPrompt({
  character: { id: ids[0], name: '가람', role: '탐정', gender: '여성', personality: '신중함', speechStyle: '짧은 존댓말', goal: '진실 찾기', secret: '없음', emotion: '집중', currentState: {} },
  state: { world: { title: '시험 세계', location: '서재', time: '밤', mood: '고요', description: '문을 조사한다.', rules: '' }, sceneSummary: '', publicDirection: '', presentationMode: 'scene', storyStatus: {}, dramaticState: {}, relationships: [], characters: [{ id: ids[0], name: '가람' }, { id: ids[1], name: '나래' }], participants: [{ characterId: ids[0] }, { characterId: ids[1] }], logs: [{ type: 'event', eventType: '비공개', text: '절대 노출되면 안 됨' }] },
  recentVisibleEvents: [
    { type: 'event', eventType: '발견', eventText: '창문이 열려 있다.' },
    { type: 'message', characterId: ids[1], text: '기존 대사', action: '기존 행동', payload: { contentBlocks: [{ type: 'ACTION', text: '먼저 창가로 물러난다.' }, { type: 'DIALOGUE', text: '불을 끄세요.' }] } }
  ]
});
assert.match(prompt, /창문이 열려 있다/);
assert.match(prompt, /행동: 먼저 창가로 물러난다.[\s\S]*대사: 불을 끄세요/);
assert.doesNotMatch(prompt, /기존 대사|기존 행동/);
assert.doesNotMatch(prompt, /절대 노출되면 안 됨/);
assert.match(prompt, /독립적으로 결정/);
assert.match(prompt, /핵심 질문·선택·관계 변화/);
assert.match(prompt, /비공개 메모이지 대사 원문이 아닙니다/);
assert.match(prompt, /반말·존댓말·호칭을 일관되게 유지/);
assert.match(prompt, /contentBlocks에는 DIALOGUE와 ACTION을 실제 발생 순서대로/);
assert.match(prompt, /WORLD_ATTEMPT/);
assert.match(prompt, /CHARACTER_ATTEMPT/);
assert.match(prompt, /character-b \| 나래/);
assert.doesNotMatch(prompt, /요구되는 결과/);

const directorCorrectionPrompt = buildDirectorProgressionPrompt({
  world: { title: '시험 세계', location: '서재', time: '밤', mood: '고요', description: '문을 조사한다.' }, dramaIntensity: 'balanced', sceneNumber: 1, sceneSignal: 'continue',
  storyState: storyState, dramaticState: queue, characters: [{ id: ids[0], name: '가람' }], logs: [], presentationMode: 'scene'
}, [{ id: ids[0], name: '가람', role: '탐정', emotion: '집중', currentState: {} }], 'WORLD_ATTEMPT를 먼저 판정하세요.');
assert.match(directorCorrectionPrompt, /재판정 지시/);
assert.match(directorCorrectionPrompt, /WORLD_ATTEMPT를 먼저 판정/);
assert.match(directorCorrectionPrompt, /핵심 질문·선택·관계/);

console.log('Latency logic verification passed.');
