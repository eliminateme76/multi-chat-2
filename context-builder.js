function publicLog(log, state, includeOutcome = false) {
  if (log.type === 'event') return `[공개 사건 · ${log.eventType || '일반'}] ${log.text}`;
  const speaker = state.characters.find((item) => item.id === log.characterId)?.name || '알 수 없는 인물';
  const outcome = includeOutcome && log.payload?.beatOutcome ? `\n(서사 결과: ${log.payload.beatOutcome}${log.payload.conditionOrCost ? ` · 조건/대가: ${log.payload.conditionOrCost}` : ''})` : '';
  return `[${speaker}] ${log.text}\n(행동: ${log.action})${outcome}`;
}

export function buildCharacterTurnPrompt({ character, state, memories = [], visibleEvents = [] }) {
  const relationships = state.relationships.filter((item) => item.from === character.id || item.to === character.id).map((item) => {
    const otherId = item.from === character.id ? item.to : item.from;
    const other = state.characters.find((candidate) => candidate.id === otherId);
    return `${other?.name || '알 수 없는 인물'}: ${item.label}, ${item.score}/100`;
  });
  const memoryText = memories.map((memory) => `- ${memory.memoryText} (당시 감정: ${memory.emotion || '기록 없음'}, 중요도: ${memory.importance})`).join('\n');
  const publicHistory = (visibleEvents.length ? visibleEvents : state.logs.slice(-6)).map((log) => publicLog(log, state)).join('\n\n');

  const outputStyle = state.presentationMode === 'chat'
    ? `이 장면은 메신저 단체 채팅입니다. 먼저 지금 실제로 답장할 이유가 있는지 판단하세요. 직접 질문받았거나, 감정·목표상 반응이 필요하거나, 새롭고 자연스러운 내용을 보탤 수 있을 때만 shouldRespond=true로 하세요. 같은 동의·조언·확인을 반복할 뿐이면 shouldRespond=false, dialogue/action은 빈 문자열, silenceReason에는 비공개 판단 이유를 쓰세요. 답장한다면 실제 메시지 1~2개만 쓰고 소설식 지문은 금지하며 action은 빈 문자열입니다.`
    : `shouldRespond=true, silenceReason은 빈 문자열로 작성하세요. 대사는 1~3문장, 행동은 필요할 때 1문장으로 작성하세요.`;
  return `당신은 한국어 이야기 시뮬레이션의 캐릭터 "${character.name}"입니다.

캐릭터 카드와 비공개 정보:
- 역할: ${character.role}
- 성별: ${character.gender}
- 성격: ${character.personality}
- 말투: ${character.speechStyle}
- 개인 목표: ${character.goal}
- 개인 비밀: ${character.secret}
- 현재 감정: ${character.emotion}
- 현재 변화 상태: ${JSON.stringify(character.currentState || {})}
- 관계: ${relationships.join(' | ') || '아직 관계 설정 없음'}

공개 세계와 활성 장면:
- 세계: ${state.world.title}
- 장소: ${state.world.location}
- 시간: ${state.world.time}
- 분위기: ${state.world.mood}
- 상황: ${state.world.description}
- 장면 요약: ${state.sceneSummary || state.world.description}
- 세계 규칙: ${state.world.rules || '없음'}
- 공개 진행 지시: ${state.publicDirection || '현재 상황에 자연스럽게 반응하세요.'}
- 현재 장면 목표: ${state.storyStatus?.objective || '현재 상황을 구체적으로 한 단계 움직입니다.'}
- 현재 딜레마: ${state.storyStatus?.dilemma || '없음'}
- 이번 비트 의도: ${state.dramaticState?.beatIntent || 'build'}
- 요구되는 결과: ${state.dramaticState?.outcomeConstraint || 'open'}
- 구체적인 조건·대가: ${state.dramaticState?.pressureSource || '없음'}
- 안도 또는 보상의 근거: ${state.dramaticState?.reliefReason || '없음'}

이 캐릭터만 가진 관련 기억:
${memoryText || '- 아직 저장된 개인 기억이 없습니다.'}

최근 공개 그룹 대화:
${publicHistory || '아직 공개 로그가 없습니다.'}

규칙:
1. 공개 정보, 자신의 카드와 자신의 기억만 사용하세요.
2. 다른 캐릭터의 목표·비밀·기억 또는 비공개 Director 상태를 아는 척하지 마세요.
3. ${outputStyle}
4. shouldRespond=true일 때만 현재 장면을 움직이는 관찰, 질문, 선택 또는 행동을 하나 포함하세요. "다음 장면으로 가자"처럼 메타적인 장면 전환을 제안하지 말고, 현재 장면 안에서 결말·반응·선택을 표현하세요. 장면 전환은 World Director만 수행합니다.
5. nextState에는 이번 응답 뒤의 단기 목표, 내적 갈등, 믿음, 약속, 성장 메모를 기존 상태와 이어지게 작성하세요. 급격한 인격 변화나 초기 설정 재작성은 금지합니다.
6. memory는 오래 유지할 가치가 있는 새 사실만 한 문장으로 작성하세요. 단순 감정 반복이나 이미 기억에 있는 내용이면 비우세요. 중요도는 0~100이며 저장할 가치가 충분할 때만 60 이상을 사용하세요.
7. relationshipChanges에는 공개된 상호작용으로 실제 변화가 생긴 경우만 -10~10 delta, 변경 뒤 관계 설명 label, 근거 reason을 작성하세요.
8. beatOutcome은 요구되는 결과와 같아야 합니다. qualified_success는 수락·성공과 함께 실제 조건이나 책임을 남기고, setback은 시도가 실제로 막힐 때만 사용합니다. 이 두 결과에서는 conditionOrCost를 구체적으로 작성하세요.
9. success나 release 비트에서는 억지 문제를 새로 만들지 말고 보상을 충분히 보여 줄 수 있습니다. 다만 직전 대사를 단순히 다시 확인하지 마세요.
10. sceneSignal은 계속 진행이면 continue, 반복되어 개입이 필요하면 stalled, 현재 장면 목표가 끝났으면 complete입니다.
11. shouldRespond=false이면 memory는 빈 문자열, memoryImportance는 0, relationshipChanges는 빈 배열, beatOutcome은 open, conditionOrCost는 빈 문자열, sceneSignal은 continue이며 nextState는 기존 상태를 유지하세요.
12. 출력은 지정된 JSON schema만 만족해야 합니다.`;
}

export function buildDirectorProgressionPrompt(state, participants) {
  const history = state.logs.slice(-24).map((log) => publicLog(log, state, true)).join('\n\n');
  const intensityRules = {
    gentle: '목표 긴장도 25~50. 내적 갈등, 타이밍, 현실적 제약처럼 되돌릴 수 있는 압력을 사용하세요.',
    balanced: '목표 긴장도 40~70. 장면마다 상충하는 욕구나 실제 대가를 하나 이상 유지하세요.',
    high: '목표 긴장도 60~90. 시간 압박, 관계 역전, 계획 실패를 적극 사용하되 중대 사건은 승인받으세요.'
  };
  return `당신은 한국어 인터랙티브 스토리의 World Director입니다. DB 상태가 기준이며, 이번 진행의 드라마 계획과 실제 응답자를 함께 결정하세요.

- 월드: ${state.world.title}
- 강도: ${state.dramaIntensity} · ${intensityRules[state.dramaIntensity] || intensityRules.balanced}
- Scene: ${state.sceneNumber} · ${state.world.location} · ${state.world.time}
- 상황: ${state.world.description}
- 장면 신호: ${state.sceneSignal}
- 구조화된 이야기 상태: ${JSON.stringify(state.storyState || {})}
- 구조화된 장면 상태: ${JSON.stringify(state.dramaticState || {})}
- 참여자:\n${participants.map((item) => `${item.id} | ${item.name} | ${item.role} | ${item.emotion} | ${JSON.stringify(item.currentState || {})}`).join('\n')}
- 최근 공개 진행:\n${history || '없음'}

action 규칙:
1. CONTINUE: 현재 장면 안에서 응답자를 1~2명 선택합니다.
2. INJECT_MINOR_EVENT: 되돌릴 수 있는 구체적 장애나 선택을 즉시 넣고 그 사건에 반응할 응답자를 선택합니다.
3. TRANSITION_SCENE: 현재 목표가 실제로 끝났을 때만 새 Scene을 설계합니다. nextScene participantIds에는 실제 현장에 있는 인물만 넣고 responders도 그 안에서 고릅니다.
4. PROPOSE_MAJOR: 죽음, 영구 부상·이탈, 중대한 비밀 폭로, 관계 파기, 세계 설정 변경처럼 되돌리기 어려운 전개가 필요할 때만 사용하고 서로 다른 2~3개 안과 각각의 대가를 작성합니다. 자동 적용하지 않습니다.
5. 한 캐릭터의 complete 신호만 믿지 말고 미해결 질문과 선택이 남았는지 검토하세요.
6. beatPlan.phase는 build/pressure/choice/consequence/release, outcome은 open/success/qualified_success/setback 중 하나입니다. 평온한 성공과 release를 정상적인 전개로 취급하세요.
7. 긴장은 파동이어야 합니다. rise를 연속 세 번 선택하지 말고, 큰 보상 뒤에는 hold 또는 fall을 우선하세요. tensionDirection은 실제 storyState.tension 변화와 일치해야 하며 ±2 이하는 hold입니다.
8. 같은 phase와 outcome이 반복되면 다음에는 기능을 바꾸세요. 그렇다고 두 번마다 사건이나 실패를 강제하지 말고, 질문을 닫거나 관점을 바꾸거나 조건부 성공을 사용할 수 있습니다.
9. qualified_success와 setback에는 인물이 원하는 것을 그대로 얻지 못하게 하는 구체적인 조건·책임·대가를 conditionOrCost에 작성하세요. release+success에는 왜 안도해도 되는지 reliefReason을 작성하세요.
10. 호의와 제안을 연속해서 무조건 수락시키지 마세요. 수락 자체가 자연스럽다면 미해결 질문을 하나 닫고, 다음 책임은 미래 상태로 남기되 즉석 위기를 덧붙이지 마세요.
11. storyState와 sceneState는 이번 판단 뒤의 완전한 최신 상태로 반환하세요. recentBeats는 최근 8개까지만 유지합니다.
12. eventPlan과 nextScene은 사용하지 않는 action에서도 빈 문자열과 빈 배열로 모든 필드를 채우세요.
13. 지정된 JSON schema만 출력하세요.`;
}

export function buildResponderSelectionPrompt({ state, participants, minimum }) {
  const events = state.logs.slice(-10).map((log) => publicLog(log, state)).join('\n');
  return `당신은 한국어 인터랙티브 스토리의 중앙 오케스트레이터입니다. 현재 장면에서 실제로 응답해야 할 참여자를 순서대로 고르세요.
장면 유형: ${state.presentationMode === 'chat' ? 'CHAT' : 'STORY'}
최소 응답자 수: ${minimum}, 최대: ${participants.length}
참여자: ${participants.map((c) => `${c.id} | ${c.name} | ${c.role} | ${c.emotion}`).join('\n')}
현재 상황: ${state.world.description}
최근 사건:\n${events || '없음'}
응답자는 중복 없이 최소 수 이상 선택하고, 각 reason은 한 문장으로 쓰세요. 지정 JSON schema만 출력하세요.`;
}

export function buildCharacterSuggestionPrompt(state) {
  const cast = state.characters.map((character) => `- ${character.name} (${character.role}): ${character.personality}; 목표 ${character.goal}`).join('\n');
  const publicHistory = state.logs.slice(-6).map((log) => publicLog(log, state)).join('\n\n');
  return `당신은 한국어 인터랙티브 스토리의 캐스팅 디렉터입니다.

현재 진행 중인 장면에 자연스럽게 합류하면서 기존 인물과 역할이 겹치지 않는 새 성인 캐릭터 한 명을 추천하세요.

- 세계: ${state.world.title}
- 장소와 시간: ${state.world.location}, ${state.world.time}
- 분위기: ${state.world.mood}
- 장면: ${state.world.description}
- 규칙: ${state.world.rules || '없음'}
- 공개 진행 지시: ${state.publicDirection || '없음'}

기존 등장인물:
${cast || '없음'}

최근 공개 진행:
${publicHistory || '없음'}

기존 인물과 이름·역할·기능이 겹치지 않게 하고, 성별은 여성/남성/논바이너리/성별 없음 중 하나로 정하세요. 현재 갈등을 움직일 목표와 현재 단서에 연결되는 비밀을 부여하세요. 다른 인물의 비밀을 이미 안다는 설정은 피하고 지정된 JSON schema만 출력하세요.`;
}

export function buildEventSuggestionsPrompt(state, desiredTypes = [], { director = false } = {}) {
  const cast = state.characters.map((character) => `${character.name}(${character.role}, 현재 감정: ${character.emotion})`).join(', ');
  const publicHistory = state.logs.slice(-10).map((log) => publicLog(log, state)).join('\n\n');
  const restrictTypes = desiredTypes.length > 0;
  const permitsTimeTransition = !restrictTypes || desiredTypes.includes('시간 전환');
  const transitionRule = permitsTimeTransition && state.presentationMode === 'chat'
    ? `이 장면은 메신저 대화입니다. 10개 중 정확히 3개는 자연스러운 시간 전환이어야 합니다. 예: 점심 대화라면 점심시간 이후, 늦은 밤이면 다음 날 아침. 시간 전환 제안은 category를 "시간 전환"으로, time에는 전환 후 시간을 짧게 쓰세요. 나머지 제안의 time은 빈 문자열로 작성하세요.`
    : permitsTimeTransition
      ? `10개 중 정확히 2개는 자연스러운 시간 전환으로 만드세요. 그 제안은 category를 "시간 전환"으로, time에는 전환 후 시간을 짧게 쓰고 나머지 제안의 time은 빈 문자열로 작성하세요.`
      : `시간 전환 제안은 만들지 말고 모든 time을 빈 문자열로 작성하세요.`;
  const typeRule = restrictTypes ? `모든 category는 사용자가 선택한 다음 타입 중 하나여야 합니다: ${desiredTypes.join(', ')}.` : `category는 일상, 관계, 연락, 선택, 발견, 돌발, 시간 전환, 분위기 중 하나를 사용하세요.`;
  return `당신은 한국어 인터랙티브 스토리의 ${director ? 'World Director' : '진행 제안자'}입니다.

현재 장면에 사용자가 즉시 투입할 수 있는 서로 다른 사건 10개를 제안하세요.

- 세계: ${state.world.title}
- 장소와 시간: ${state.world.location}, ${state.world.time}
- 분위기: ${state.world.mood}
- 현재 상황: ${state.world.description}
- 장면 요약: ${state.sceneSummary}
- 등장인물: ${cast}

최근 공개 진행:
${publicHistory || '없음'}

규칙:
1. 각 사건은 클릭 즉시 발생해도 자연스러운 구체적인 한 문장으로 작성하세요.
2. 대규모 세계관 설명보다 일상적인 연락, 방문, 약속, 오해, 발견, 선택처럼 바로 반응할 수 있는 일을 우선하세요.
3. 최근 대화를 그대로 반복하거나 아직 공개되지 않은 캐릭터 비밀을 폭로하지 마세요.
4. ${typeRule}
5. 열 사건의 내용과 기능이 서로 겹치지 않게 하세요.
6. ${transitionRule}
7. 최소 3개는 흔한 클리셰를 피한 기발한 제안으로 만드세요. 우연한 오발송, 엉뚱한 물건이나 사진, 예상 밖의 제3자 반응, 사소하지만 선택을 부르는 생활 문제처럼 세계관과 인물 관계에서 자연스럽게 파생되어야 합니다.
8. 기발함을 위해 갑작스러운 범죄, 재난, 초능력, 비밀 폭로를 남발하지 마세요.
9. ${director ? '당신의 이전 대화 기억은 참고만 하고, 아래 DB 상태가 항상 기준입니다.' : '지정된 JSON schema만 출력하세요.'}
10. 지정된 JSON schema만 출력하세요.`;
}

function directorStateText(state) {
  const history = state.logs.slice(-30).map((log) => publicLog(log, state)).join('\n\n');
  return `DB 기준 월드 상태:
- 세계: ${state.world.title}
- 활성 Scene: ${state.sceneNumber} · ${state.world.location} · ${state.world.time} · ${state.world.mood}
- 현재 상황: ${state.world.description}
- Scene 요약: ${state.sceneSummary || '없음'}
- 공개 진행 지시: ${state.publicDirection || '없음'}
- 최근 공개 사건과 대화:\n${history || '없음'}`;
}

export function buildDirectorEventApplyPrompt(state, event) {
  return `당신은 한국어 인터랙티브 스토리의 World Director입니다. DB 상태를 기준으로 사건을 지금 적용할 방법을 결정하세요.

${directorStateText(state)}

적용 요청:
- 사건 타입: ${event.eventType}
- 사건 본문: ${event.text}
- 전환 후 시간 후보: ${event.time || '없음'}
- 강제 새 Scene: ${event.forceScene ? '예' : '아니오'}
- 이전 Scene에서 만든 추천인가: ${event.stale ? '예' : '아니오'}

규칙:
1. forceScene이 예이거나 사건 타입이 시간 전환이면 applyMode는 CREATE_SCENE이어야 합니다.
2. 이전 Scene 추천은 현재 문맥에 맞게 본문을 자연스럽게 조정할 수 있습니다.
3. CREATE_SCENE이면 새 Scene의 location, mood, time, description을 구체적으로 작성하세요.
4. APPEND_EVENT이면 현재 Scene의 location, mood, description을 그대로 반환하고 time은 빈 문자열로 하세요.
5. 캐릭터 대사는 쓰지 말고, 사건과 장면 설계만 JSON schema로 반환하세요.`;
}

export function buildDirectorSceneTransitionPrompt(state) {
  return `당신은 한국어 인터랙티브 스토리의 World Director입니다. 현재 Scene은 캐릭터들의 complete 신호로 목표를 마쳤습니다. 다음 Scene으로 자연스럽게 전환하세요.

${directorStateText(state)}

규칙:
1. applyMode는 반드시 CREATE_SCENE입니다.
2. text에는 장면 전환을 일으킨 짧고 구체적인 사건을 쓰세요.
3. eventType은 시간 전환, 선택, 발견, 관계, 분위기 중 가장 맞는 하나를 사용하세요.
4. time, location, mood, description은 새 Scene 상태로 작성하세요.
5. 캐릭터 대사나 메타 설명 없이 JSON schema만 반환하세요.`;
}

export function buildStoryRepairPrompt({ state, sceneHistory, memories }) {
  return `당신은 Sceneweaver의 이야기 연속성 편집자입니다. 기존 기록을 삭제하거나 새 사건을 만들지 말고, 현재 DB 상태를 기록에 맞게 보정하는 제안만 작성하세요.

현재 상태:
${JSON.stringify({ world: state.world, sceneNumber: state.sceneNumber, storyState: state.storyState, dramaticState: state.dramaticState, characters: state.characters.map(({ id,name,role,goal,emotion,currentState }) => ({ id,name,role,goal,emotion,currentState })), relationships: state.relationships, participants: state.participants })}

Scene 기록:
${JSON.stringify(sceneHistory)}

활성 기억:
${JSON.stringify(memories)}

규칙:
1. 대화와 사건을 바꾸거나 새로운 사건을 만들어내지 마세요.
2. characterStates는 모든 캐릭터를 한 번씩 포함하고 현재까지 드러난 단기 목표·내적 갈등·믿음·약속·성장만 반영하세요.
3. relationships는 기존 방향성 관계를 모두 포함하고 기록으로 입증되는 현재 설명과 점수를 제안하세요. 점수 변화는 기존 값에서 최대 20입니다.
4. participantIds에는 현재 Scene 상황을 직접 경험하는 캐릭터만 넣되 최소 1명이어야 합니다.
5. memoryDecisions는 제공된 기억을 모두 KEEP 또는 ARCHIVE로 분류하세요. 중복 감정 확인은 보관하고 고유한 사실·약속·결정은 유지하세요. 캐릭터별 KEEP은 최대 12개입니다.
6. storyState에는 현재 활성 갈등과 미해결 질문을 복원하고, sceneState에는 현재 장면의 목표·대가·딜레마를 작성하세요.
7. summary에는 사용자가 변경 이유를 이해할 수 있는 한국어 설명을 작성하세요.
8. 지정된 JSON schema만 출력하세요.`;
}

export function buildWorldDraftPrompt({ draft, messages, userMessage }) {
  const history = messages.slice(-12).map((message) => `${message.role === 'USER' ? '사용자' : '월드 설계자'}: ${message.content}`).join('\n');
  return `당신은 Sceneweaver의 한국어 월드 설계자입니다. 사용자와 여러 번 대화하며 즉시 플레이할 수 있는 새 월드 초안을 다듬으세요.

현재 DB 초안:
${JSON.stringify(draft)}

최근 대화:
${history || '아직 대화가 없습니다.'}

새 사용자 요청:
${userMessage}

규칙:
1. reply에는 변경한 내용과 다음에 선택하면 좋은 핵심 질문을 한국어로 자연스럽게 답하세요. 질문은 한 번에 최대 2개입니다.
2. 정보가 부족해도 합리적인 기본값으로 완전한 draft를 작성하고 missingItems에 더 확인하면 좋은 항목을 기록하세요.
3. 이전 초안과 사용자의 명시적 선택을 유지하고, 이번 요청과 충돌하는 부분만 수정하세요.
4. 캐릭터는 2~6명이며 수를 지정하지 않으면 3명입니다. 이름과 key는 서로 달라야 하고 key는 영문 소문자로 시작하세요.
5. 관계는 서로 다른 두 캐릭터의 key를 한 쌍으로 표현하세요. 모든 조합을 억지로 채우지 말고 이야기상 의미 있는 관계만 작성하세요.
6. 세계 이름 50자, 장소·분위기 70자, 시간 40자, 장면 설명·규칙 300자, 캐릭터 이름 20자, 역할 40자, 나머지 캐릭터 설명 120자를 넘기지 마세요.
7. color는 #RRGGBB, presentationMode는 scene 또는 chat, dramaIntensity는 gentle/balanced/high 중 하나이며 지정하지 않으면 balanced입니다.
8. story에는 반복 가능한 핵심 긴장 1~5개와 첫 미해결 질문을 작성하세요. 갈등은 즉시 해소되지 않고 선택의 대가가 있어야 합니다.
9. 첫 Scene은 캐릭터들이 즉시 말하거나 행동할 수 있는 구체적인 상황이어야 합니다.
10. 사용자가 비밀을 요구하지 않아도 각 캐릭터의 행동 동기가 될 비공개 secret을 작성하세요.
11. 지정된 JSON schema만 출력하세요.`;
}
