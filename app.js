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
let storyRepairProposal = null;
let currentProjectId = new URLSearchParams(window.location.search).get('project');
let modelCatalog = [];
let worldDrafts = [];
let activeWorldDraft = null;
let worldDraftBusy = false;
let worldDraftDirty = false;
let runtimeSettings = null;
let runtimeSettingsBusy = false;
const ALL_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const $ = (selector) => document.querySelector(selector);
const esc = (text) => String(text).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const characterById = (id) => state.characters.find((character) => character.id === id);
const avatar = (character) => `<span class="avatar" style="background:${character.color}">${character.portraitUrl ? `<img src="${esc(character.portraitUrl)}" style="object-position:${esc(character.portraitPosition || '50%')} center" alt="${esc(character.name)} 얼굴" />` : character.emoji}</span>`;

function fillModelSelect(select, value = '') {
  const inherit = select.dataset.inherit;
  const values = [...new Set(modelCatalog.map((model) => model.id).concat(value || []).filter(Boolean))];
  select.innerHTML = `${inherit ? `<option value="">${esc(inherit)}</option>` : ''}${values.map((id) => { const model = modelCatalog.find((item) => item.id === id); return `<option value="${esc(id)}">${esc(model?.name || id)}</option>`; }).join('')}`;
  select.value = value || '';
}
function fillEffortSelect(select, modelId, value = '') {
  const inherit = select.dataset.inherit;
  const supported = modelCatalog.find((model) => model.id === modelId)?.efforts?.filter(Boolean);
  const efforts = [...new Set((supported?.length ? supported : ALL_EFFORTS).concat(value || []).filter(Boolean))];
  select.innerHTML = `${inherit ? `<option value="">${esc(inherit)}</option>` : ''}${efforts.map((effort) => `<option value="${esc(effort)}">${esc(effort)}</option>`).join('')}`;
  select.value = value || '';
}
function wireRuntimeSelects(form, values) {
  const pairs = [
    ['characterModel','characterEffort'],['directorModel','directorEffort'],['utilityModel','utilityEffort'],['modelOverride','reasoningEffortOverride']
  ];
  for (const [modelName, effortName] of pairs) {
    const modelSelect = form.elements[modelName]; const effortSelect = form.elements[effortName];
    if (!modelSelect || !effortSelect) continue;
    fillModelSelect(modelSelect, values[modelName] || '');
    fillEffortSelect(effortSelect, modelSelect.value || state?.aiSettings?.character.model, values[effortName] || '');
    modelSelect.onchange = () => {
      const selectedModel = modelSelect.value || state?.aiSettings?.character.model;
      const model = modelCatalog.find((item) => item.id === selectedModel);
      const nextEffort = model?.efforts?.includes(effortSelect.value) ? effortSelect.value : model?.defaultEffort || '';
      fillEffortSelect(effortSelect, selectedModel, nextEffort);
    };
  }
}

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
}
function render() {
  $('#world-title').textContent = state.world.title; $('#scene-number').textContent = String(state.sceneNumber).padStart(2, '0'); $('#scene-location-compact').textContent = state.world.location; $('#scene-location').textContent = state.world.location; $('#scene-description').textContent = state.world.description; $('#scene-time').textContent = state.world.time; $('#scene-mood').textContent = state.world.mood; $('#scene-mood-compact').textContent = state.world.mood; $('#director-note').textContent = state.directorNote; renderTurnControls(); setDirectorTab(directorTab);
  $('#character-list').innerHTML = state.characters.map((character, index) => `<button class="character ${(typingCharacter?.id === character.id || (!typingCharacter && !state.conversationSettled && index === state.turn % state.characters.length)) ? 'selected' : ''}" data-edit="${character.id}">${avatar(character)}<span><strong>${esc(character.name)}</strong><small>${esc(character.gender)} · ${esc(character.role)}</small><small>${typingCharacter?.id === character.id ? '입력 중…' : character.conversation?.idle ? '대화 종료' : esc(character.emotion)}</small></span></button>`).join('');
  document.querySelectorAll('[data-edit]').forEach((button) => { button.onclick = () => openCharacterModal(button.dataset.edit); });
  $('#conversation-log').classList.toggle('chat-mode', state.presentationMode === 'chat');
  const typingMessage = state.presentationMode === 'chat' && typingCharacter ? `<article class="message typing-message">${avatar(typingCharacter)}<div><div class="message-meta"><span class="message-name">${esc(typingCharacter.name)}</span></div><p class="typing-indicator"><i></i><i></i><i></i><span>입력 중</span></p></div></article>` : '';
  $('#conversation-log').innerHTML = state.logs.map((log, index) => { const latest = index === state.logs.length - 1 ? ' latest-message' : ''; if (log.type === 'event') return `<div class="message event${latest}"><strong>DIRECTOR EVENT · ${esc(log.eventType || '일반')}</strong>${esc(log.text)}</div>`; const c = characterById(log.characterId); return `<article class="message${latest}">${avatar(c)}<div><div class="message-meta"><span class="message-name">${esc(c.name)}</span><span class="message-role">${esc(c.gender)} · ${esc(c.role)}</span></div><p class="message-text">${esc(log.text)}</p>${log.action ? `<p class="message-action">${esc(log.action)}</p>` : ''}</div></article>`; }).join('') + typingMessage;
  const log = $('#conversation-log'); log.scrollTop = log.scrollHeight;
  const status = state.storyStatus || {};
  const intensityLabel = { gentle: '잔잔하게', balanced: '균형 있게', high: '강하게' }[status.intensity] || '균형 있게';
  const tensions = (status.activeTensions || []).map((item) => `${esc(item.summary)} · ${Number(item.pressure || 0)}`).join('<br>') || '아직 뚜렷한 갈등 없음';
  $('#state-list').innerHTML = `${state.repairNeeded ? '<button id="open-story-repair" class="story-repair-alert" type="button">기존 기록을 분석해 이야기 상태 만들기 →</button>' : ''}<div><dt>STORY</dt><dd>${esc(intensityLabel)} · 긴장 ${Number(status.tension || 0)} · ${esc(status.arcPhase || 'setup')}</dd></div><div><dt>SCENE OBJECTIVE</dt><dd>${esc(status.objective || state.publicDirection || '현재 선택을 드러냅니다.')}</dd></div><div><dt>ACTIVE TENSIONS</dt><dd>${tensions}</dd></div><div><dt>TIME</dt><dd>${esc(state.world.time)}</dd></div>`;
  $('#open-story-repair')?.addEventListener('click', openStoryRepair);
  $('#relationship-list').innerHTML = state.relationships.map((r) => `<div class="relationship"><div class="relationship-top"><strong>${esc(characterById(r.from)?.name)} ↔ ${esc(characterById(r.to)?.name)}</strong><span>${r.score}</span></div><span>${esc(r.label)}</span><div class="meter"><i style="width:${r.score}%"></i></div></div>`).join(''); renderSuggestions();
}
function renderSuggestions() {
  const major = state?.pendingMajorDecision;
  const current = eventSuggestions.filter((suggestion) => !suggestion.stale);
  const previous = eventSuggestions.filter((suggestion) => suggestion.stale);
  const cards = (suggestions) => suggestions.map((suggestion) => `<button class="suggestion ${suggestion.stale ? 'stale' : ''} ${suggestion.severity === 'MAJOR' ? 'major' : ''}" data-suggestion-id="${esc(suggestion.id)}"><b>[${esc(suggestion.category)}${suggestion.time ? ` · ${esc(suggestion.time)}` : ''}]</b>${esc(suggestion.text)}${suggestion.consequence ? `<small>${esc(suggestion.consequence)}</small>` : ''}</button>`).join('');
  const majorBlock = major ? `<div class="major-decision"><strong>중대 전개를 선택해 주세요</strong><p>선택하기 전에는 자동 진행이 멈춥니다.</p>${cards((major.options || []).map((option) => ({ ...option, severity: 'MAJOR' })))}<button class="secondary-button" id="reject-major-options" type="button">모두 보류</button></div>` : '';
  $('#suggestion-list').innerHTML = majorBlock || (eventSuggestions.length
    ? `${current.length ? `<div class="suggestion-group"><span>현재 장면 추천</span>${cards(current)}</div>` : ''}${previous.length ? `<div class="suggestion-group previous"><span>이전 장면 추천 · 현재 문맥으로 재검토</span>${cards(previous)}</div>` : ''}`
    : '<span class="suggestion-empty">AI 전개 추천을 누르면 현재 대화에 맞는 사건 10개를 제안합니다.</span>');
  document.querySelectorAll('[data-suggestion-id]').forEach((button) => { button.onclick = () => applySuggestion(button.dataset.suggestionId); });
  $('#reject-major-options')?.addEventListener('click', rejectMajorOptions);
}
function renderEventTimeInput() { const input = $('#event-time-input'); const isTransition = $('#event-type-select').value === '시간 전환'; input.hidden = !isTransition; input.required = isTransition; if (!isTransition) input.value = ''; }
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
    let completedStepCount = 0;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      operation = await api(`/api/operations/${queued.operationId}`);
      const runningStep = operation.steps?.find((step) => step.status === 'RUNNING');
      const actualTypingCharacter = runningStep ? participants.find((character) => character.id === runningStep.characterId) || characterById(runningStep.characterId) || { id: runningStep.characterId, name: runningStep.characterName } : null;
      if (typingCharacter?.id !== actualTypingCharacter?.id) { typingCharacter = actualTypingCharacter; render(); }
      if (runningStep) $('#save-status').textContent = `${runningStep.characterName} · 응답 생성 중…`;
      else if (!operation.steps?.length) $('#save-status').textContent = '월드 디렉터 · 세계 상황 판단 중…';
      const completedNow = operation.steps?.filter((step) => step.status === 'COMPLETED').length || 0;
      if (completedNow > completedStepCount && operation.status !== 'COMPLETED') {
        completedStepCount = completedNow;
        setState(await api('/api/state'));
        $('#save-status').textContent = '응답 저장 완료 · 진행 마무리 중…';
      }
      if (operation.status === 'COMPLETED' || operation.status === 'FAILED') break;
      await new Promise((resolve) => setTimeout(resolve, runningStep ? 500 : 1000));
    }
    if (!operation || operation.status !== 'COMPLETED') throw new Error(operation?.error || '진행 작업이 완료되지 않았습니다.');
    const nextState = await api('/api/state');
    typingCharacter = null;
    setState(nextState);
    const messagesCreated = Number(operation.result?.messagesCreated || 0);
    if (messagesCreated > 0) consecutiveSilentTurns = 0;
    else {
      consecutiveSilentTurns += 1;
      $('#save-status').textContent = '이번 진행에서는 새 메시지가 없었습니다.';
    }
    if (operation.result?.awaitingDecision || nextState.pendingMajorDecision) {
      stopAutoProgress(); setDirectorTab('events'); setToolsOpen(true);
      $('#save-status').textContent = '중대 전개 선택 대기 중';
    } else if (nextState.conversationSettled) {
      stopAutoProgress();
      $('#save-status').textContent = '현재 대화 종료 · Director가 다음 진행을 판단합니다.';
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
  try { setState(await api('/api/events', { method: 'POST', body: JSON.stringify({ text, time, eventType }) })); await refreshEventSuggestions(); setToolsOpen(false); if (!turnInFlight) await advanceTurn(); return true; } catch (error) { if (automatic) throw error; alert(error.message); return false; }
}
async function applySuggestion(suggestionId, { automatic = false } = {}) {
  if (turnInFlight && !automatic) { pendingEventAction = () => applySuggestion(suggestionId, { automatic }); $('#save-status').textContent = '현재 응답 뒤에 사건 투입 대기 중…'; return true; }
  try { setState(await api(`/api/events/suggestions/${suggestionId}/apply`, { method: 'POST', body: JSON.stringify({ automatic }) })); await refreshEventSuggestions(); setToolsOpen(false); if (!turnInFlight) await advanceTurn(); return true; } catch (error) { if (automatic) throw error; alert(error.message); return false; }
}
async function rejectMajorOptions() { if (!state.pendingMajorDecision) return; try { stopAutoProgress(); setState(await api(`/api/events/suggestion-batches/${state.pendingMajorDecision.batchId}/reject`, { method: 'POST', body: '{}' })); await refreshEventSuggestions(); } catch (error) { alert(error.message); } }
function renderStoryRepairProposal() {
  const content = $('#story-repair-content');
  if (!storyRepairProposal) { content.innerHTML = '<p>기존 대화·사건·기억을 읽어 현재 갈등, 인물 상태와 관계를 복원합니다. 기존 기록은 바꾸지 않습니다.</p><button id="generate-story-repair" class="primary-button" type="button">Codex로 보정안 생성</button>'; $('#apply-story-repair').hidden = true; $('#reject-story-repair').hidden = true; $('#generate-story-repair').onclick = generateStoryRepair; return; }
  const proposal = storyRepairProposal.proposal;
  const names = new Map(state.characters.map((character) => [character.id, character.name]));
  content.innerHTML = `<p class="repair-summary">${esc(proposal.summary)}</p><dl class="repair-preview"><div><dt>현재 갈등</dt><dd>${(proposal.storyState.activeTensions || []).map((item) => `${esc(item.summary)} · ${item.pressure}`).join('<br>') || '없음'}</dd></div><div><dt>장면 목표</dt><dd>${esc(proposal.sceneState.objective)}</dd></div><div><dt>참여자</dt><dd>${proposal.participantIds.map((id) => esc(names.get(id) || id)).join(', ')}</dd></div><div><dt>관계 보정</dt><dd>${proposal.relationships.map((item) => `${esc(names.get(item.from) || '')} → ${esc(names.get(item.to) || '')}: ${esc(item.label)} (${item.score})`).join('<br>')}</dd></div></dl>`;
  $('#apply-story-repair').hidden = false; $('#reject-story-repair').hidden = false;
}
async function openStoryRepair() { storyRepairProposal = (await api('/api/story-repair')).proposal; renderStoryRepairProposal(); $('#story-repair-modal').showModal(); }
async function generateStoryRepair() { const button = $('#generate-story-repair'); button.disabled = true; button.textContent = '기록 분석 중…'; try { storyRepairProposal = (await api('/api/story-repair', { method: 'POST', body: '{}' })).proposal; renderStoryRepairProposal(); } catch (error) { alert(error.message); button.disabled = false; button.textContent = 'Codex로 보정안 생성'; } }
async function decideStoryRepair(decision) { if (!storyRepairProposal) return; try { const result = await api(`/api/story-repair/${storyRepairProposal.id}/${decision}`, { method: 'POST', body: '{}' }); $('#story-repair-modal').close(); storyRepairProposal = null; if (result.state) setState(result.state); else setState(await api('/api/state')); } catch (error) { alert(error.message); } }
function openCharacterModal(id) { editingId = id || null; const c = id ? characterById(id) : {}; const form = $('#character-form'); $('#character-modal-title').textContent = id ? `${c.name} Agent 편집` : '새 캐릭터 만들기'; for (const key of ['name', 'gender', 'role', 'personality', 'speechStyle', 'goal', 'secret']) form.elements[key].value = c[key] || (key === 'gender' ? '여성' : ''); wireRuntimeSelects(form, { modelOverride: c.modelOverride || '', reasoningEffortOverride: c.reasoningEffortOverride || '' }); $('#character-modal').showModal(); }
async function saveCharacter() { const form = $('#character-form'); if (!form.reportValidity()) return; try { setState(await api(editingId ? `/api/characters/${editingId}` : '/api/characters', { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) })); $('#character-modal').close(); } catch (error) { alert(error.message); } }
function openWorldModal() { const form = $('#world-form'); Object.entries(state.world).forEach(([key, value]) => { form.elements[key].value = value; }); wireRuntimeSelects(form, { characterModel: state.aiSettings.character.model, characterEffort: state.aiSettings.character.reasoningEffort, directorModel: state.aiSettings.director.model, directorEffort: state.aiSettings.director.reasoningEffort, utilityModel: state.aiSettings.utility.model, utilityEffort: state.aiSettings.utility.reasoningEffort }); $('#world-modal').showModal(); }
async function saveWorld() { const form = $('#world-form'); if (!form.reportValidity()) return; try { setState(await api('/api/world', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(form))) })); $('#world-modal').close(); } catch (error) { alert(error.message); } }
async function saveAiSettings() { const form = $('#world-form'); const data = Object.fromEntries(new FormData(form)); try { setState(await api('/api/ai-settings', { method: 'PUT', body: JSON.stringify(data) })); $('#save-status').textContent = 'AI 실행 설정 저장됨'; } catch (error) { alert(error.message); } }

const shortThreadId = (threadId) => threadId ? `${threadId.slice(0, 8)}…${threadId.slice(-6)}` : '';
function runtimeSettingRow({ owner, id = '', title, badge, badgeClass = '', threadId = null, threadLabel = '', model, reasoningEffort, inherit = false }) {
  const identity = threadId ? `스레드 ${shortThreadId(threadId)}` : threadLabel;
  return `<article class="runtime-setting-row" data-runtime-owner="${esc(owner)}" data-runtime-id="${esc(id)}">
    <div class="runtime-setting-identity"><div class="runtime-setting-title"><strong>${esc(title)}</strong><span class="runtime-kind-badge ${esc(badgeClass)}">${esc(badge)}</span></div><span class="runtime-setting-thread" title="${esc(threadId || identity)}">${esc(identity)}</span></div>
    <label>모델<select data-runtime-model ${inherit ? 'data-inherit="월드 기본 모델"' : ''} data-initial="${esc(model || '')}"></select></label>
    <label>추론 수준<select data-runtime-effort ${inherit ? 'data-inherit="월드 기본 수준"' : ''} data-initial="${esc(reasoningEffort || '')}"></select><span class="runtime-effective"></span></label>
  </article>`;
}

function runtimeProjectRow(owner) { return $(`[data-runtime-owner="${owner}"]`); }
function effectiveRuntimeModel(row) {
  const selected = row.querySelector('[data-runtime-model]').value;
  if (selected) return selected;
  return runtimeProjectRow('project-character')?.querySelector('[data-runtime-model]').value || state.aiSettings.character.model;
}
function effectiveRuntimeEffort(row) {
  const selected = row.querySelector('[data-runtime-effort]').value;
  if (selected) return selected;
  return runtimeProjectRow('project-character')?.querySelector('[data-runtime-effort]').value || state.aiSettings.character.reasoningEffort;
}
function updateRuntimeEffective(row) {
  const effective = row.querySelector('.runtime-effective');
  if (effective) effective.textContent = `적용값 · ${effectiveRuntimeModel(row)} · ${effectiveRuntimeEffort(row)}`;
}
function refreshRuntimeEffort(row, preferred = '') {
  const effortSelect = row.querySelector('[data-runtime-effort]');
  const modelId = effectiveRuntimeModel(row);
  const model = modelCatalog.find((item) => item.id === modelId);
  let next = preferred;
  const inheritedEffort = runtimeProjectRow('project-character')?.querySelector('[data-runtime-effort]').value || state.aiSettings.character.reasoningEffort;
  if (model?.efforts?.length) {
    const effectivePreferred = next || (effortSelect.dataset.inherit ? inheritedEffort : '');
    if (!model.efforts.includes(effectivePreferred)) next = model.defaultEffort && model.efforts.includes(model.defaultEffort) ? model.defaultEffort : model.efforts[0];
  }
  fillEffortSelect(effortSelect, modelId, next);
  updateRuntimeEffective(row);
}
function refreshCharacterRuntimeRows() {
  document.querySelectorAll('[data-runtime-owner="character"]').forEach((row) => refreshRuntimeEffort(row, row.querySelector('[data-runtime-effort]').value));
}
function wireRuntimeSettingsRows() {
  document.querySelectorAll('.runtime-setting-row').forEach((row) => {
    const modelSelect = row.querySelector('[data-runtime-model]');
    const effortSelect = row.querySelector('[data-runtime-effort]');
    fillModelSelect(modelSelect, modelSelect.dataset.initial || '');
    refreshRuntimeEffort(row, effortSelect.dataset.initial || '');
    modelSelect.onchange = () => {
      refreshRuntimeEffort(row, effortSelect.value);
      if (row.dataset.runtimeOwner === 'project-character') refreshCharacterRuntimeRows();
    };
    effortSelect.onchange = () => {
      if (effortSelect.dataset.inherit && !effortSelect.value) refreshRuntimeEffort(row, '');
      else updateRuntimeEffective(row);
      if (row.dataset.runtimeOwner === 'project-character') refreshCharacterRuntimeRows();
    };
  });
}
function renderRuntimeSettings() {
  const content = $('#runtime-settings-content');
  if (!runtimeSettings) { content.innerHTML = '<div class="runtime-settings-loading">설정을 불러오는 중…</div>'; return; }
  const project = runtimeSettings.project;
  content.innerHTML = `<section class="runtime-settings-group"><div class="runtime-settings-group-heading"><div><span class="eyebrow">WORLD DEFAULTS</span><h3>월드 공통 작업</h3></div><span>역할별 기본 실행 설정</span></div>
    ${runtimeSettingRow({ owner: 'project-character', title: project.character.name, badge: 'DEFAULT', threadLabel: '개별 설정이 없는 캐릭터가 상속', model: project.character.model, reasoningEffort: project.character.reasoningEffort })}
    ${runtimeSettingRow({ owner: 'project-director', title: project.director.name, badge: 'DIRECTOR', threadId: project.director.threadId, threadLabel: '첫 호출 전 · 스레드 없음', model: project.director.model, reasoningEffort: project.director.reasoningEffort })}
    ${runtimeSettingRow({ owner: 'project-utility', title: project.utility.name, badge: 'ONE-SHOT', badgeClass: 'utility', threadLabel: '호출마다 임시 스레드 생성 후 정리', model: project.utility.model, reasoningEffort: project.utility.reasoningEffort })}</section>
    <section class="runtime-settings-group"><div class="runtime-settings-group-heading"><div><span class="eyebrow">CHARACTER THREADS</span><h3>캐릭터</h3></div><span>${runtimeSettings.characters.length}명 · 개별 설정 또는 월드 기본값</span></div>
    ${runtimeSettings.characters.length ? runtimeSettings.characters.map((character) => runtimeSettingRow({ owner: 'character', id: character.id, title: character.name, badge: 'CHARACTER', threadId: character.threadId, threadLabel: '첫 응답 전 · 스레드 없음', model: character.modelOverride, reasoningEffort: character.reasoningEffortOverride, inherit: true })).join('') : '<div class="runtime-empty">등록된 캐릭터가 없습니다.</div>'}</section>
    <section class="runtime-settings-group"><div class="runtime-settings-group-heading"><div><span class="eyebrow">WORLD BUILDERS</span><h3>진행 중인 월드 설계자</h3></div><span>${runtimeSettings.worldBuilders.length}개 · 초안별 지속 스레드</span></div>
    ${runtimeSettings.worldBuilders.length ? runtimeSettings.worldBuilders.map((builder) => runtimeSettingRow({ owner: 'world-builder', id: builder.id, title: builder.name, badge: 'BUILDER', badgeClass: 'builder', threadId: builder.threadId, threadLabel: '첫 대화 전 · 스레드 없음', model: builder.model, reasoningEffort: builder.reasoningEffort })).join('') : '<div class="runtime-empty">진행 중인 월드 초안이 없습니다.</div>'}</section>`;
  wireRuntimeSettingsRows();
}
function setRuntimeSettingsBusy(busy, status = '') {
  runtimeSettingsBusy = busy;
  $('#runtime-settings-form').dataset.busy = String(busy);
  $('#save-runtime-settings').disabled = busy;
  $('#save-runtime-settings').textContent = busy ? '저장 중…' : '전체 설정 저장';
  if (status) $('#runtime-settings-status').textContent = status;
}
async function openRuntimeSettings() {
  runtimeSettings = null;
  renderRuntimeSettings();
  $('#runtime-settings-modal').showModal();
  setRuntimeSettingsBusy(true, 'Codex app-server에서 모델 목록을 확인하는 중…');
  try {
    const [catalog, settings] = await Promise.all([api('/api/models'), api('/api/runtime/settings')]);
    modelCatalog = catalog.models || [];
    runtimeSettings = settings;
    renderRuntimeSettings();
    setRuntimeSettingsBusy(false, '기존 스레드 유지 · 다음 호출부터 적용');
  } catch (error) {
    setRuntimeSettingsBusy(false, '설정을 불러오지 못했습니다.');
    alert(error.message);
  }
}
function collectRuntimeSettings() {
  const readPair = (owner) => {
    const row = runtimeProjectRow(owner);
    return { model: row.querySelector('[data-runtime-model]').value, reasoningEffort: row.querySelector('[data-runtime-effort]').value };
  };
  return {
    project: { character: readPair('project-character'), director: readPair('project-director'), utility: readPair('project-utility') },
    characters: runtimeSettings.characters.map((character) => {
      const row = $(`[data-runtime-owner="character"][data-runtime-id="${character.id}"]`);
      return { id: character.id, modelOverride: row.querySelector('[data-runtime-model]').value || null, reasoningEffortOverride: row.querySelector('[data-runtime-effort]').value || null };
    }),
    worldBuilders: runtimeSettings.worldBuilders.map((builder) => {
      const row = $(`[data-runtime-owner="world-builder"][data-runtime-id="${builder.id}"]`);
      return { id: builder.id, model: row.querySelector('[data-runtime-model]').value, reasoningEffort: row.querySelector('[data-runtime-effort]').value };
    })
  };
}
async function saveRuntimeSettings(event) {
  event.preventDefault();
  if (!runtimeSettings || runtimeSettingsBusy) return;
  setRuntimeSettingsBusy(true, '전체 설정을 검증하고 저장하는 중…');
  try {
    runtimeSettings = await api('/api/runtime/settings', { method: 'PUT', body: JSON.stringify(collectRuntimeSettings()) });
    setState(await api('/api/state'));
    $('#save-status').textContent = 'AI 스레드 설정 저장됨';
    $('#runtime-settings-modal').close();
  } catch (error) {
    setRuntimeSettingsBusy(false, '저장되지 않았습니다. 값을 확인해 주세요.');
    alert(error.message);
  }
}

function setWorldDraftBusy(busy, message = '') {
  worldDraftBusy = busy;
  $('#world-builder-card')?.setAttribute('data-busy', String(busy));
  const send = $('#world-builder-send');
  send.disabled = busy;
  send.textContent = busy ? '월드 설계자가 생각 중…' : '설계자에게 보내기';
  $('#create-world-from-draft').disabled = busy || !activeWorldDraft?.draft?.characters?.length;
  if (message) $('#world-draft-save-state').textContent = message;
}

function renderWorldDraftList() {
  const select = $('#world-draft-select');
  select.innerHTML = worldDrafts.length
    ? worldDrafts.map((item) => `<option value="${esc(item.id)}">${esc(item.draft?.world?.title || '이름 없는 초안')} · ${new Date(item.updatedAt).toLocaleString()}</option>`).join('')
    : '<option value="">작성 중인 초안 없음</option>';
  select.value = activeWorldDraft?.id || '';
}

function renderWorldDraft() {
  renderWorldDraftList();
  const draft = activeWorldDraft?.draft;
  const messages = activeWorldDraft?.messages || [];
  $('#world-builder-messages').innerHTML = messages.length
    ? messages.map((message) => `<article class="world-builder-message ${message.role === 'USER' ? 'user' : 'assistant'}"><small>${message.role === 'USER' ? '나' : '월드 설계자'}</small>${esc(message.content)}</article>`).join('')
    : '<div class="world-builder-empty"><strong>만들고 싶은 세계를 편하게 이야기해 주세요.</strong><br>장르, 분위기, 등장인물 또는 시작 상황 중 생각난 것만 말해도 나머지는 설계자가 초안으로 채워드립니다.</div>';
  const log = $('#world-builder-messages'); log.scrollTop = log.scrollHeight;
  const world = draft?.world || {};
  const story = draft?.story || {};
  $('#world-draft-world').innerHTML = `<label>세계 이름<input name="title" maxlength="50" value="${esc(world.title || '')}"></label><label>진행 방식<select name="presentationMode"><option value="scene" ${world.presentationMode !== 'chat' ? 'selected' : ''}>STORY</option><option value="chat" ${world.presentationMode === 'chat' ? 'selected' : ''}>CHAT</option></select></label><label>극적 강도<select name="dramaIntensity"><option value="gentle" ${world.dramaIntensity === 'gentle' ? 'selected' : ''}>잔잔하게</option><option value="balanced" ${world.dramaIntensity !== 'gentle' && world.dramaIntensity !== 'high' ? 'selected' : ''}>균형 있게</option><option value="high" ${world.dramaIntensity === 'high' ? 'selected' : ''}>강하게</option></select></label><label>첫 장소<input name="location" maxlength="70" value="${esc(world.location || '')}"></label><label>첫 시간<input name="time" maxlength="40" value="${esc(world.time || '')}"></label><label class="full">분위기<input name="mood" maxlength="70" value="${esc(world.mood || '')}"></label><label class="full">이야기 전제<textarea name="premise" maxlength="300">${esc(story.premise || '')}</textarea></label><label class="full">첫 미해결 질문<input name="openingQuestion" maxlength="240" value="${esc(story.openingQuestion || '')}"></label><label class="full">첫 장면 설명<textarea name="description" maxlength="300">${esc(world.description || '')}</textarea></label><label class="full">세계 규칙<textarea name="rules" maxlength="300">${esc(world.rules || '')}</textarea></label>`;
  $('#world-draft-characters').innerHTML = draft?.characters?.length
    ? draft.characters.map((character, index) => `<article class="world-draft-character" data-draft-character="${index}" data-key="${esc(character.key)}"><label>표식<input data-field="emoji" maxlength="8" value="${esc(character.emoji)}"></label><label>이름<input data-field="name" maxlength="20" value="${esc(character.name)}"></label><label>성별<select data-field="gender">${['여성','남성','논바이너리','성별 없음'].map((gender) => `<option ${character.gender === gender ? 'selected' : ''}>${gender}</option>`).join('')}</select></label><label class="wide">역할<input data-field="role" maxlength="40" value="${esc(character.role)}"></label><label>색상<input data-field="color" maxlength="7" value="${esc(character.color)}"></label><span class="character-key full">KEY · ${esc(character.key)}</span><label class="full">성격<input data-field="personality" maxlength="120" value="${esc(character.personality)}"></label><label class="full">말투<input data-field="speechStyle" maxlength="120" value="${esc(character.speechStyle)}"></label><label class="full">목표<textarea data-field="goal" maxlength="120">${esc(character.goal)}</textarea></label><label class="full">비밀<textarea data-field="secret" maxlength="120">${esc(character.secret)}</textarea></label><label class="full">초기 감정<input data-field="emotion" maxlength="80" value="${esc(character.emotion)}"></label></article>`).join('')
    : '<div class="world-draft-none">첫 요청을 보내면 캐릭터 초안이 여기에 나타납니다.</div>';
  const names = new Map((draft?.characters || []).map((character) => [character.key, character.name]));
  $('#world-draft-relationships').innerHTML = draft?.relationships?.length
    ? draft.relationships.map((relationship, index) => `<article class="world-draft-relationship" data-draft-relationship="${index}" data-first="${esc(relationship.characterKeys[0])}" data-second="${esc(relationship.characterKeys[1])}"><strong>${esc(names.get(relationship.characterKeys[0]) || relationship.characterKeys[0])} ↔ ${esc(names.get(relationship.characterKeys[1]) || relationship.characterKeys[1])}</strong><label>관계 설명<input data-field="label" maxlength="120" value="${esc(relationship.label)}"></label><label>점수<input data-field="score" type="number" min="0" max="100" value="${relationship.score}"></label></article>`).join('')
    : '<div class="world-draft-none">설정된 초기 관계가 없습니다.</div>';
  const missing = draft?.missingItems || [];
  $('#world-draft-missing').hidden = !missing.length;
  $('#world-draft-missing').textContent = missing.length ? `더 정하면 좋은 항목 · ${missing.join(' · ')}` : '';
  $('#world-draft-form').querySelectorAll('input,textarea,select').forEach((input) => { input.oninput = () => { worldDraftDirty = true; $('#world-draft-save-state').textContent = '저장하지 않은 수정 내용'; }; });
  worldDraftDirty = false;
  $('#world-draft-save-state').textContent = activeWorldDraft ? `${activeWorldDraft.model} · ${activeWorldDraft.reasoningEffort}` : '초안을 선택하세요';
  setWorldDraftBusy(worldDraftBusy);
}

function collectWorldDraft() {
  const form = $('#world-draft-form');
  const world = Object.fromEntries(['title','location','mood','time','description','rules','presentationMode','dramaIntensity'].map((name) => [name, form.elements[name]?.value || '']));
  const characters = [...form.querySelectorAll('[data-draft-character]')].map((card) => ({
    key: card.dataset.key,
    ...Object.fromEntries(['name','gender','role','emoji','color','personality','speechStyle','goal','secret','emotion'].map((field) => [field, card.querySelector(`[data-field="${field}"]`).value]))
  }));
  const relationships = [...form.querySelectorAll('[data-draft-relationship]')].map((card) => ({ characterKeys: [card.dataset.first, card.dataset.second], label: card.querySelector('[data-field="label"]').value, score: Number(card.querySelector('[data-field="score"]').value) }));
  const previousTensions = activeWorldDraft?.draft?.story?.coreTensions || [];
  const story = { premise: form.elements.premise?.value || world.description, openingQuestion: form.elements.openingQuestion?.value || '', coreTensions: previousTensions.length ? previousTensions : [{ summary: world.description, involvedCharacterKeys: characters.map((character) => character.key), pressure: 40 }] };
  return { world, story, characters, relationships, missingItems: activeWorldDraft?.draft?.missingItems || [] };
}

async function loadWorldDrafts(selectedId = activeWorldDraft?.id) {
  worldDrafts = (await api('/api/world-drafts')).drafts;
  const selected = worldDrafts.find((item) => item.id === selectedId) || worldDrafts[0];
  activeWorldDraft = selected ? await api(`/api/world-drafts/${selected.id}`) : null;
  renderWorldDraft();
}

async function newWorldDraft() {
  setWorldDraftBusy(true, '새 초안 만드는 중…');
  try {
    activeWorldDraft = await api('/api/world-drafts', { method: 'POST', body: '{}' });
    await loadWorldDrafts(activeWorldDraft.id);
  } finally { setWorldDraftBusy(false); }
}

async function openWorldBuilder() {
  $('#world-builder-modal').showModal();
  try { await loadWorldDrafts(); if (!activeWorldDraft) await newWorldDraft(); }
  catch (error) { alert(`월드 초안을 불러오지 못했습니다.\n${error.message}`); }
}

async function persistWorldDraft() {
  if (!activeWorldDraft) return false;
  setWorldDraftBusy(true, '초안 저장 중…');
  try {
    activeWorldDraft = await api(`/api/world-drafts/${activeWorldDraft.id}`, { method: 'PUT', body: JSON.stringify({ draft: collectWorldDraft() }) });
    worldDrafts = worldDrafts.map((item) => item.id === activeWorldDraft.id ? activeWorldDraft : item);
    worldDraftDirty = false; renderWorldDraft(); return true;
  } catch (error) { alert(`초안을 저장하지 못했습니다.\n${error.message}`); return false; }
  finally { setWorldDraftBusy(false); }
}

async function sendWorldDraftMessage(event) {
  event.preventDefault();
  if (!activeWorldDraft || worldDraftBusy) return;
  const input = $('#world-builder-input'); const message = input.value.trim();
  if (!message) return;
  if (worldDraftDirty && !(await persistWorldDraft())) return;
  setWorldDraftBusy(true, '월드 설계자가 초안을 다듬는 중…');
  try {
    activeWorldDraft = await api(`/api/world-drafts/${activeWorldDraft.id}/messages`, { method: 'POST', body: JSON.stringify({ message }) });
    input.value = ''; await loadWorldDrafts(activeWorldDraft.id);
  } catch (error) { alert(`월드 설계자 응답에 실패했습니다.\n${error.message}`); }
  finally { setWorldDraftBusy(false); }
}

async function createWorldFromActiveDraft() {
  if (!activeWorldDraft || worldDraftBusy) return;
  if (worldDraftDirty && !(await persistWorldDraft())) return;
  setWorldDraftBusy(true, '새 월드 생성 중…');
  try {
    const result = await api(`/api/world-drafts/${activeWorldDraft.id}/create`, { method: 'POST', body: '{}' });
    stopAutoProgress(); currentProjectId = result.projectId;
    await loadProjectOptions(currentProjectId); setState(result.state);
    eventSuggestions = []; renderSuggestions();
    const url = new URL(window.location.href); url.searchParams.set('project', currentProjectId); window.history.replaceState({}, '', url);
    $('#world-builder-modal').close();
  } catch (error) { alert(`월드를 생성하지 못했습니다.\n${error.message}`); }
  finally { setWorldDraftBusy(false); }
}

async function cancelActiveWorldDraft() {
  if (!activeWorldDraft || worldDraftBusy || !confirm('이 월드 초안과 생성 대화를 취소할까요?')) return;
  setWorldDraftBusy(true, '초안 취소 중…');
  try { await api(`/api/world-drafts/${activeWorldDraft.id}/cancel`, { method: 'POST', body: '{}' }); activeWorldDraft = null; await loadWorldDrafts(); if (!activeWorldDraft) await newWorldDraft(); }
  catch (error) { alert(`초안을 취소하지 못했습니다.\n${error.message}`); }
  finally { setWorldDraftBusy(false); }
}
async function loadProjectOptions(selectedId = currentProjectId) {
  const projects = await api('/api/projects');
  if (!projects.length) throw new Error('등록된 세계관이 없습니다.');
  $('#project-select').innerHTML = projects.map((project) => `<option value="${esc(project.id)}">${esc(project.title)} · ${esc(project.mood)}</option>`).join('');
  currentProjectId = projects.some((project) => project.id === selectedId) ? selectedId : projects[0].id;
  $('#project-select').value = currentProjectId;
  return projects;
}
async function resetCurrentPlaythrough() {
  if (!confirm(`「${state.world.title}」의 대화, 사건, 기억과 관계 변화를 모두 지우고 처음부터 시작할까요?\n세계관과 초기 캐릭터 설정은 유지됩니다.`)) return;
  stopAutoProgress();
  try {
    $('#save-status').textContent = '현재 진행 초기화 중…';
    setState(await api('/api/projects/reset', { method: 'POST', body: '{}' }));
    eventSuggestions = []; renderSuggestions();
    $('#project-actions').removeAttribute('open');
  } catch (error) { $('#save-status').textContent = '초기화 실패'; alert(error.message); }
}
async function cloneCurrentPlaythrough() {
  const title = prompt('새 진행의 이름을 입력하세요.', `${state.world.title} · 새 진행`);
  if (title === null || !title.trim()) return;
  stopAutoProgress();
  try {
    $('#save-status').textContent = '별도 진행 생성 중…';
    const result = await api('/api/projects/clone', { method: 'POST', body: JSON.stringify({ title: title.trim() }) });
    currentProjectId = result.projectId;
    await loadProjectOptions(currentProjectId);
    setState(result.state);
    eventSuggestions = []; renderSuggestions();
    $('#project-actions').removeAttribute('open');
    const url = new URL(window.location.href); url.searchParams.set('project', currentProjectId); window.history.replaceState({}, '', url);
  } catch (error) { $('#save-status').textContent = '새 진행 생성 실패'; alert(error.message); }
}

$('#advance-button').onclick = advanceTurn;
$('#auto-button').onclick = () => { if (autoEnabled) stopAutoProgress(); else { autoEnabled = true; scheduleAutoTurn(0); } renderTurnControls(); };
$('#open-character-modal').onclick = () => openCharacterModal(); $('#open-world-modal').onclick = openWorldModal;
$('#open-runtime-settings').onclick = openRuntimeSettings;
$('#open-world-builder').onclick = openWorldBuilder;
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
$('#reset-playthrough-button').onclick = resetCurrentPlaythrough;
$('#clone-playthrough-button').onclick = cloneCurrentPlaythrough;
document.addEventListener('click', (event) => { const menu = $('#project-actions'); if (menu.open && !menu.contains(event.target)) menu.removeAttribute('open'); });
$('#save-ai-settings-button').onclick = saveAiSettings;
$('#apply-story-repair').onclick = () => decideStoryRepair('apply');
$('#reject-story-repair').onclick = () => decideStoryRepair('reject');
$('#runtime-settings-form').onsubmit = saveRuntimeSettings;
$('#world-builder-chat-form').onsubmit = sendWorldDraftMessage;
$('#new-world-draft').onclick = newWorldDraft;
$('#save-world-draft').onclick = persistWorldDraft;
$('#create-world-from-draft').onclick = createWorldFromActiveDraft;
$('#cancel-world-draft').onclick = cancelActiveWorldDraft;
$('#world-draft-select').onchange = (event) => loadWorldDrafts(event.target.value).catch((error) => alert(error.message));
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
    try { modelCatalog = (await api('/api/models')).models || []; } catch { modelCatalog = [{ id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', efforts: ALL_EFFORTS }]; }
    const projects = await loadProjectOptions(currentProjectId);
    if (!projects.some((project) => project.id === currentProjectId)) currentProjectId = projects[0].id;
    $('#project-select').onchange = (event) => selectProject(event.target.value).catch((error) => { $('#save-status').textContent = '전환 실패'; alert(error.message); });
    await selectProject(currentProjectId);
  } catch (error) {
    $('#save-status').textContent = 'DB 설정 필요';
    alert(`${error.message}\n\nREADME의 PostgreSQL 설정 단계를 실행하세요.`);
  }
}
initialize();
renderEventTimeInput();
