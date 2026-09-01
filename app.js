let state;
let editingId = null;
let autoTimer = null;
let autoEnabled = false;
let turnInFlight = false;
let pendingEventAction = null;
let directorTab = 'state';
let typingCharacter = null;
let consecutiveSilentTurns = 0;
let eventSuggestions = [];
let autoEventEnabled = false;
let autoEventInFlight = false;
let turnsSinceAutoEvent = 0;
const AUTO_EVENT_TURN_INTERVAL = 12;
const EVENT_TYPES = ['일상', '관계', '연락', '선택', '발견', '돌발', '시간 전환', '분위기'];
let selectedAutoEventTypes = new Set(EVENT_TYPES);
let currentProjectId = new URLSearchParams(window.location.search).get('project');
const $ = (selector) => document.querySelector(selector);
const esc = (text) => String(text).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const characterById = (id) => state.characters.find((character) => character.id === id);
const avatar = (character) => `<span class="avatar" style="background:${character.color}">${character.portraitUrl ? `<img src="${esc(character.portraitUrl)}" style="object-position:${esc(character.portraitPosition || '50%')} center" alt="${esc(character.name)} 얼굴" />` : character.emoji}</span>`;

async function api(url, options = {}) {
  const scopedUrl = currentProjectId && url !== '/api/projects' ? `${url}${url.includes('?') ? '&' : '?'}projectId=${encodeURIComponent(currentProjectId)}` : url;
  const response = await fetch(scopedUrl, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '요청에 실패했습니다.');
  return body;
}
function setState(nextState) { state = nextState; currentProjectId = nextState.projectId; $('#project-select').value = currentProjectId; $('#monitor-link').href = `./monitor.html?project=${encodeURIComponent(currentProjectId)}`; $('#save-status').textContent = 'PostgreSQL 저장됨'; render(); }
function setDirectorTab(tab) {
  directorTab = tab;
  document.querySelectorAll('[data-director-tab]').forEach((button) => { const active = button.dataset.directorTab === tab; button.classList.toggle('is-active', active); button.setAttribute('aria-selected', String(active)); });
  document.querySelectorAll('[data-director-panel]').forEach((panel) => { panel.hidden = panel.dataset.directorPanel !== tab; });
}
function setToolsOpen(open) { document.body.classList.toggle('tools-open', open); }
function renderTurnControls() {
  const advanceButton = $('#advance-button');
  advanceButton.disabled = turnInFlight || !state;
  advanceButton.setAttribute('aria-busy', String(turnInFlight));
  advanceButton.innerHTML = turnInFlight ? '<span>…</span> 다음 턴 생성 중…' : '<span>✦</span> 다음 턴 진행';
  const autoButton = $('#auto-button');
  autoButton.classList.toggle('is-active', autoEnabled);
  autoButton.setAttribute('aria-pressed', String(autoEnabled));
  $('#auto-state').textContent = autoEnabled ? 'ON' : 'OFF';
  const autoEventButton = $('#auto-event-button');
  autoEventButton.classList.toggle('is-active', autoEventEnabled);
  autoEventButton.disabled = autoEventInFlight;
  autoEventButton.setAttribute('aria-pressed', String(autoEventEnabled));
  $('#auto-event-state').textContent = autoEventInFlight ? '생성 중' : autoEventEnabled ? `${turnsSinceAutoEvent}/${AUTO_EVENT_TURN_INTERVAL}` : 'OFF';
}
function render() {
  $('#world-title').textContent = state.world.title; $('#scene-number').textContent = String(state.sceneNumber).padStart(2, '0'); $('#scene-location-compact').textContent = state.world.location; $('#scene-location').textContent = state.world.location; $('#scene-description').textContent = state.world.description; $('#scene-time').textContent = state.world.time; $('#scene-mood').textContent = state.world.mood; $('#scene-mood-compact').textContent = state.world.mood; $('#director-note').textContent = state.directorNote; renderTurnControls(); setDirectorTab(directorTab);
  $('#character-list').innerHTML = state.characters.map((character, index) => `<button class="character ${(typingCharacter?.id === character.id || (!typingCharacter && !state.conversationSettled && index === state.turn % state.characters.length)) ? 'selected' : ''}" data-edit="${character.id}">${avatar(character)}<span><strong>${esc(character.name)}</strong><small>${esc(character.gender)} · ${esc(character.role)}</small><small>${typingCharacter?.id === character.id ? '입력 중…' : character.conversation?.idle ? '대화 종료' : esc(character.emotion)}</small></span></button>`).join('');
  document.querySelectorAll('[data-edit]').forEach((button) => { button.onclick = () => openCharacterModal(button.dataset.edit); });
  $('#conversation-log').classList.toggle('chat-mode', state.presentationMode === 'chat');
  const typingMessage = state.presentationMode === 'chat' && typingCharacter ? `<article class="message typing-message">${avatar(typingCharacter)}<div><div class="message-meta"><span class="message-name">${esc(typingCharacter.name)}</span></div><p class="typing-indicator"><i></i><i></i><i></i><span>입력 중</span></p></div></article>` : '';
  $('#conversation-log').innerHTML = state.logs.map((log, index) => { const latest = index === state.logs.length - 1 ? ' latest-message' : ''; if (log.type === 'event') return `<div class="message event${latest}"><strong>DIRECTOR EVENT · ${esc(log.eventType || '일반')}</strong>${esc(log.text)}</div>`; const c = characterById(log.characterId); return `<article class="message${latest}">${avatar(c)}<div><div class="message-meta"><span class="message-name">${esc(c.name)}</span><span class="message-role">${esc(c.gender)} · ${esc(c.role)}</span></div><p class="message-text">${esc(log.text)}</p>${log.action ? `<p class="message-action">${esc(log.action)}</p>` : ''}</div></article>`; }).join('') + typingMessage;
  const log = $('#conversation-log'); log.scrollTop = log.scrollHeight;
  $('#state-list').innerHTML = `<div><dt>TIME</dt><dd>${esc(state.world.time)}</dd></div><div><dt>SCENE STATUS</dt><dd>${esc(state.sceneSignal || 'continue')}</dd></div><div><dt>CURRENT SITUATION</dt><dd>${esc(state.world.description)}</dd></div><div><dt>WORLD RULES</dt><dd>${esc(state.world.rules || '설정된 규칙 없음')}</dd></div>`;
  $('#relationship-list').innerHTML = state.relationships.map((r) => `<div class="relationship"><div class="relationship-top"><strong>${esc(characterById(r.from)?.name)} ↔ ${esc(characterById(r.to)?.name)}</strong><span>${r.score}</span></div><span>${esc(r.label)}</span><div class="meter"><i style="width:${r.score}%"></i></div></div>`).join(''); renderSuggestions();
}
function renderSuggestions() {
  const current = eventSuggestions.filter((suggestion) => !suggestion.stale);
  const previous = eventSuggestions.filter((suggestion) => suggestion.stale);
  const cards = (suggestions) => suggestions.map((suggestion) => `<button class="suggestion ${suggestion.stale ? 'stale' : ''}" data-suggestion-id="${esc(suggestion.id)}"><b>[${esc(suggestion.category)}${suggestion.time ? ` · ${esc(suggestion.time)}` : ''}]</b>${esc(suggestion.text)}</button>`).join('');
  $('#suggestion-list').innerHTML = eventSuggestions.length
    ? `${current.length ? `<div class="suggestion-group"><span>현재 장면 추천</span>${cards(current)}</div>` : ''}${previous.length ? `<div class="suggestion-group previous"><span>이전 장면 추천 · 현재 문맥으로 재검토</span>${cards(previous)}</div>` : ''}`
    : '<span class="suggestion-empty">AI 전개 추천을 누르면 현재 대화에 맞는 사건 10개를 제안합니다.</span>';
  document.querySelectorAll('[data-suggestion-id]').forEach((button) => { button.onclick = () => applySuggestion(button.dataset.suggestionId); });
}
function renderEventTimeInput() { const input = $('#event-time-input'); const isTransition = $('#event-type-select').value === '시간 전환'; input.hidden = !isTransition; input.required = isTransition; if (!isTransition) input.value = ''; }
function renderEventTypeFilters() {
  $('#event-type-filters').innerHTML = EVENT_TYPES.map((type) => `<label class="event-type-chip"><input type="checkbox" value="${esc(type)}" ${selectedAutoEventTypes.has(type) ? 'checked' : ''}><span>${esc(type)}</span></label>`).join('');
  $('#event-type-filters').querySelectorAll('input').forEach((input) => { input.onchange = () => { if (input.checked) selectedAutoEventTypes.add(input.value); else selectedAutoEventTypes.delete(input.value); if (!selectedAutoEventTypes.size) { input.checked = true; selectedAutoEventTypes.add(input.value); } }; });
}
function stopAutoProgress() { autoEnabled = false; if (autoTimer) clearTimeout(autoTimer); autoTimer = null; }
function scheduleAutoTurn(delay = 1000) {
  if (!autoEnabled) return;
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = setTimeout(async () => {
    autoTimer = null;
    if (!autoEnabled) return;
    if (turnInFlight) return scheduleAutoTurn(500);
    const completed = await advanceTurn();
    if (autoEnabled && completed) scheduleAutoTurn();
  }, delay);
  renderTurnControls();
}
async function advanceTurn() {
  if (turnInFlight || !state) return false;
  turnInFlight = true;
  $('#save-status').textContent = '다음 턴 생성 중…';
  renderTurnControls();
  try {
    const participants = (await api('/api/participants')).participants;
    typingCharacter = null;
    render();
    const queued = await api('/api/turns', { method: 'POST' });
    let operation;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      operation = await api(`/api/operations/${queued.operationId}`);
      const runningStep = operation.steps?.find((step) => step.status === 'RUNNING');
      const actualTypingCharacter = runningStep ? participants.find((character) => character.id === runningStep.characterId) || characterById(runningStep.characterId) : null;
      if (typingCharacter?.id !== actualTypingCharacter?.id) { typingCharacter = actualTypingCharacter; render(); }
      if (operation.status === 'COMPLETED' || operation.status === 'FAILED') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!operation || operation.status !== 'COMPLETED') throw new Error(operation?.error || '진행 작업이 완료되지 않았습니다.');
    const nextState = await api('/api/state');
    typingCharacter = null;
    setState(nextState);
    const messagesCreated = Number(operation.result?.messagesCreated || 0);
    if (messagesCreated > 0) {
      consecutiveSilentTurns = 0;
      turnsSinceAutoEvent += messagesCreated;
    } else {
      consecutiveSilentTurns += 1;
      $('#save-status').textContent = '이번 진행에서는 새 메시지가 없었습니다.';
    }
    const eventInjected = await maybeInjectAutomaticEvent();
    if (nextState.conversationSettled && !eventInjected) {
      stopAutoProgress();
      $('#save-status').textContent = autoEventEnabled ? '모두 대화 종료 · 자동 사건을 기다림' : '모두 대화 종료 · 자동 진행 멈춤';
    }
    return true;
  } catch (error) {
    stopAutoProgress();
    $('#save-status').textContent = '진행 실패';
    alert(error.message);
    return false;
  } finally {
    typingCharacter = null;
    turnInFlight = false;
    if (state) render();
    renderTurnControls();
    if (pendingEventAction) {
      const action = pendingEventAction;
      pendingEventAction = null;
      queueMicrotask(action);
    }
  }
}
async function refreshEventSuggestions() { eventSuggestions = (await api('/api/events/suggestions')).suggestions; renderSuggestions(); }
async function addEvent(text, time = '', { automatic = false, eventType = '일반' } = {}) {
  if (!text.trim()) return false;
  if (turnInFlight && !automatic) { pendingEventAction = () => addEvent(text, time, { automatic, eventType }); $('#save-status').textContent = '현재 응답 뒤에 사건 투입 대기 중…'; return true; }
  try { setState(await api('/api/events', { method: 'POST', body: JSON.stringify({ text, time, eventType }) })); await refreshEventSuggestions(); setToolsOpen(false); turnsSinceAutoEvent = 0; if (!turnInFlight) await advanceTurn(); return true; } catch (error) { if (automatic) throw error; alert(error.message); return false; }
}
async function applySuggestion(suggestionId, { automatic = false } = {}) {
  if (turnInFlight && !automatic) { pendingEventAction = () => applySuggestion(suggestionId, { automatic }); $('#save-status').textContent = '현재 응답 뒤에 사건 투입 대기 중…'; return true; }
  try { setState(await api(`/api/events/suggestions/${suggestionId}/apply`, { method: 'POST', body: JSON.stringify({ automatic }) })); await refreshEventSuggestions(); setToolsOpen(false); turnsSinceAutoEvent = 0; if (!turnInFlight) await advanceTurn(); return true; } catch (error) { if (automatic) throw error; alert(error.message); return false; }
}
async function maybeInjectAutomaticEvent() {
  if (!autoEventEnabled || autoEventInFlight) return false;
  const settled = Boolean(state?.conversationSettled);
  const desiredTypes = [...selectedAutoEventTypes].filter((type) => type !== '시간 전환' || settled);
  const dueByMessages = turnsSinceAutoEvent >= AUTO_EVENT_TURN_INTERVAL;
  const dueBySettlement = settled && selectedAutoEventTypes.has('시간 전환');
  if ((!dueByMessages && !dueBySettlement) || !desiredTypes.length) return false;
  autoEventInFlight = true; $('#save-status').textContent = '자동 사건 생성 중…'; renderTurnControls();
  try {
    const response = await api('/api/events/suggest', { method: 'POST', body: JSON.stringify({ desiredTypes }) });
    const suggestions = response.generatedSuggestions || response.suggestions;
    const eligible = suggestions.filter((suggestion) => selectedAutoEventTypes.has(suggestion.category));
    if (!eligible.length) throw new Error('선택한 방향에 맞는 사건이 생성되지 않았습니다.');
    const suggestion = eligible[Math.floor(Math.random() * eligible.length)];
    await applySuggestion(suggestion.id, { automatic: true });
    $('#save-status').textContent = `자동 사건 투입됨 · ${suggestion.category}`;
    return true;
  } catch (error) {
    autoEventEnabled = false;
    $('#save-status').textContent = '자동 사건 실패';
    alert(`자동 사건 투입을 중지했습니다.\n${error.message}`);
  } finally { autoEventInFlight = false; renderTurnControls(); }
  return false;
}
function openCharacterModal(id) { editingId = id || null; const c = id ? characterById(id) : {}; $('#character-modal-title').textContent = id ? `${c.name} Agent 편집` : '새 캐릭터 만들기'; for (const key of ['name', 'gender', 'role', 'personality', 'speechStyle', 'goal', 'secret']) $('#character-form').elements[key].value = c[key] || (key === 'gender' ? '여성' : ''); $('#character-modal').showModal(); }
async function saveCharacter() { const form = $('#character-form'); if (!form.reportValidity()) return; try { setState(await api(editingId ? `/api/characters/${editingId}` : '/api/characters', { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) })); $('#character-modal').close(); } catch (error) { alert(error.message); } }
function openWorldModal() { const form = $('#world-form'); Object.entries(state.world).forEach(([key, value]) => { form.elements[key].value = value; }); $('#world-modal').showModal(); }
async function saveWorld() { const form = $('#world-form'); if (!form.reportValidity()) return; try { setState(await api('/api/world', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(form))) })); $('#world-modal').close(); } catch (error) { alert(error.message); } }

$('#advance-button').onclick = advanceTurn;
$('#auto-button').onclick = () => { if (autoEnabled) stopAutoProgress(); else { autoEnabled = true; scheduleAutoTurn(0); } renderTurnControls(); };
$('#auto-event-button').onclick = () => { autoEventEnabled = !autoEventEnabled; if (!autoEventEnabled) turnsSinceAutoEvent = 0; renderTurnControls(); };
$('#open-character-modal').onclick = () => openCharacterModal(); $('#open-world-modal').onclick = openWorldModal;
$('#open-world-modal-from-scene').onclick = openWorldModal;
$('#open-tools-button').onclick = () => setToolsOpen(true);
$('#tools-scrim').onclick = () => setToolsOpen(false);
document.querySelectorAll('[data-director-tab]').forEach((button) => { button.onclick = () => setDirectorTab(button.dataset.directorTab); });
$('#event-form').onsubmit = (event) => { event.preventDefault(); const time = $('#event-time-input').value; addEvent($('#event-input').value, time, { eventType: $('#event-type-select').value }); $('#event-input').value = ''; $('#event-time-input').value = ''; };
$('#event-type-select').onchange = renderEventTimeInput;
$('#suggest-button').onclick = async () => {
  const button = $('#suggest-button');
  button.disabled = true; button.textContent = '✦ 사건 생성 중…';
  $('#suggestion-list').innerHTML = '<span class="suggestion-empty">현재 장면과 최근 대화를 읽고 있습니다…</span>';
  try { eventSuggestions = (await api('/api/events/suggest', { method: 'POST', body: JSON.stringify({}) })).suggestions; renderSuggestions(); }
  catch (error) { eventSuggestions = []; renderSuggestions(); alert(`사건 추천에 실패했습니다.\n${error.message}`); }
  finally { button.disabled = false; button.textContent = '✦ AI 전개 추천'; }
};
$('#character-form').onsubmit = (event) => { event.preventDefault(); saveCharacter(); }; $('#world-form').onsubmit = (event) => { event.preventDefault(); saveWorld(); };
$('#ai-character-button').onclick = async () => {
  const button = $('#ai-character-button');
  const form = $('#character-form');
  button.disabled = true;
  button.textContent = '✦ 현재 장면 분석 중…';
  try {
    const suggestion = await api('/api/characters/suggest', { method: 'POST' });
    for (const field of ['name', 'gender', 'role', 'personality', 'speechStyle', 'goal', 'secret']) form.elements[field].value = suggestion[field];
  } catch (error) {
    alert(`캐릭터 추천에 실패했습니다.\n${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = '✦ 현재 장면 기반 추천';
  }
};
document.querySelectorAll('[data-close]').forEach((button) => { button.onclick = () => $(`#${button.dataset.close}`).close(); });
$('#reset-button').style.display = 'none';
async function selectProject(projectId) {
  stopAutoProgress();
  eventSuggestions = [];
  turnsSinceAutoEvent = 0;
  currentProjectId = projectId;
  const url = new URL(window.location.href);
  url.searchParams.set('project', projectId);
  window.history.replaceState({}, '', url);
  $('#save-status').textContent = '세계관 불러오는 중…';
  setState(await api('/api/state'));
  await refreshEventSuggestions();
}
async function initialize() {
  try {
    const projects = await api('/api/projects');
    if (!projects.length) throw new Error('등록된 세계관이 없습니다.');
    $('#project-select').innerHTML = projects.map((project) => `<option value="${esc(project.id)}">${esc(project.title)} · ${esc(project.mood)}</option>`).join('');
    if (!projects.some((project) => project.id === currentProjectId)) currentProjectId = projects[0].id;
    $('#project-select').onchange = (event) => selectProject(event.target.value).catch((error) => { $('#save-status').textContent = '전환 실패'; alert(error.message); });
    await selectProject(currentProjectId);
  } catch (error) {
    $('#save-status').textContent = 'DB 설정 필요';
    alert(`${error.message}\n\nREADME의 PostgreSQL 설정 단계를 실행하세요.`);
  }
}
initialize();
renderEventTypeFilters();
renderEventTimeInput();
