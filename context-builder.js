function publicLog(log, state) {
  if (log.type === 'event') return `[공개 사건 · ${log.eventType || '일반'}] ${log.text}`;
  const speaker = state.characters.find((item) => item.id === log.characterId)?.name || '알 수 없는 인물';
  return `[${speaker}] ${log.text}\n(행동: ${log.action})`;
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

이 캐릭터만 가진 관련 기억:
${memoryText || '- 아직 저장된 개인 기억이 없습니다.'}

최근 공개 그룹 대화:
${publicHistory || '아직 공개 로그가 없습니다.'}

규칙:
1. 공개 정보, 자신의 카드와 자신의 기억만 사용하세요.
2. 다른 캐릭터의 목표·비밀·기억 또는 비공개 Director 상태를 아는 척하지 마세요.
3. ${outputStyle}
4. shouldRespond=true일 때만 현재 장면을 움직이는 관찰, 질문, 선택 또는 행동을 하나 포함하세요. "다음 장면으로 가자"처럼 메타적인 장면 전환을 제안하지 말고, 현재 장면 안에서 결말·반응·선택을 표현하세요. 장면 전환은 World Director만 수행합니다.
5. memory는 이 캐릭터가 나중에 기억할 가치가 있는 새 사실만 한 문장으로 작성하고, 없으면 빈 문자열로 작성하세요.
6. relationshipChanges에는 공개된 상호작용으로 실제 변화가 생긴 경우만 -10~10 범위로 작성하세요.
7. sceneSignal은 계속 진행이면 continue, 반복되어 개입이 필요하면 stalled, 현재 장면 목표가 끝났으면 complete입니다.
8. shouldRespond=false이면 memory는 빈 문자열, memoryImportance는 0, relationshipChanges는 빈 배열, sceneSignal은 continue로 작성하세요.
9. 출력은 지정된 JSON schema만 만족해야 합니다.`;
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
