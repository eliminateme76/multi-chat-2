let state;
let editingId = null;
let autoTimer = null;
const $ = (selector) => document.querySelector(selector);
const esc = (text) => String(text).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const characterById = (id) => state.characters.find((character) => character.id === id);

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '요청에 실패했습니다.');
  return body;
}
function setState(nextState) { state = nextState; $('#save-status').textContent = 'PostgreSQL 저장됨'; render(); }
function render() {
  $('#world-title').textContent = state.world.title; $('#scene-number').textContent = String(state.sceneNumber).padStart(2, '0'); $('#scene-location').textContent = state.world.location; $('#scene-description').textContent = state.world.description; $('#scene-mood').textContent = state.world.mood; $('#director-note').textContent = state.directorNote; $('#auto-state').textContent = autoTimer ? 'ON' : 'OFF';
  $('#character-list').innerHTML = state.characters.map((character, index) => `<button class="character ${index === state.turn % state.characters.length ? 'selected' : ''}" data-edit="${character.id}"><span class="avatar" style="background:${character.color}">${character.emoji}</span><span><strong>${esc(character.name)}</strong><small>${esc(character.role)} · ${esc(character.emotion)}</small></span></button>`).join('');
  document.querySelectorAll('[data-edit]').forEach((button) => { button.onclick = () => openCharacterModal(button.dataset.edit); });
  $('#conversation-log').innerHTML = state.logs.map((log) => { if (log.type === 'event') return `<div class="message event"><strong>DIRECTOR EVENT</strong>${esc(log.text)}</div>`; const c = characterById(log.characterId); return `<article class="message"><span class="avatar" style="background:${c.color}">${c.emoji}</span><div><div class="message-meta"><span class="message-name">${esc(c.name)}</span><span class="message-role">${esc(c.role)}</span></div><p class="message-text">${esc(log.text)}</p><p class="message-action">${esc(log.action)}</p></div></article>`; }).join('');
  const log = $('#conversation-log'); log.scrollTop = log.scrollHeight;
  $('#state-list').innerHTML = `<div><dt>TIME</dt><dd>${esc(state.world.time)}</dd></div><div><dt>SCENE GOAL</dt><dd>금서의 정체와 사라진 스승의 단서를 찾는다.</dd></div><div><dt>WORLD RULES</dt><dd>${esc(state.world.rules || '설정된 규칙 없음')}</dd></div>`;
  $('#relationship-list').innerHTML = state.relationships.map((r) => `<div class="relationship"><div class="relationship-top"><strong>${esc(characterById(r.from)?.name)} ↔ ${esc(characterById(r.to)?.name)}</strong><span>${r.score}</span></div><span>${esc(r.label)}</span><div class="meter"><i style="width:${r.score}%"></i></div></div>`).join(''); renderSuggestions();
}
const suggestions = ['[미스터리] 봉인된 서가 뒤에서 누군가의 발자국이 이어진다.', '[갈등] 교장의 목소리가 들리며, 금서를 가진 사람은 자수하라고 명령한다.', '[관계] 폭풍으로 문이 잠기고 두 명만 보관실에 남는다.'];
function renderSuggestions() { $('#suggestion-list').innerHTML = suggestions.map((s) => `<button class="suggestion" data-suggestion="${esc(s)}"><b>${s.match(/^\[[^]+?\]/)[0]}</b>${esc(s.replace(/^\[[^]+?\]\s*/, ''))}</button>`).join(''); document.querySelectorAll('[data-suggestion]').forEach((button) => { button.onclick = () => addEvent(button.dataset.suggestion.replace(/^\[[^]+?\]\s*/, '')); }); }
async function advanceTurn() { try { setState(await api('/api/turns', { method: 'POST' })); } catch (error) { alert(error.message); } }
async function addEvent(text) { if (!text.trim()) return; try { setState(await api('/api/events', { method: 'POST', body: JSON.stringify({ text }) })); } catch (error) { alert(error.message); } }
function openCharacterModal(id) { editingId = id || null; const c = id ? characterById(id) : {}; $('#character-modal-title').textContent = id ? `${c.name} Agent 편집` : '새 캐릭터 만들기'; for (const key of ['name', 'role', 'personality', 'speechStyle', 'goal', 'secret']) $('#character-form').elements[key].value = c[key] || ''; $('#character-modal').showModal(); }
async function saveCharacter() { const form = $('#character-form'); if (!form.reportValidity()) return; try { setState(await api(editingId ? `/api/characters/${editingId}` : '/api/characters', { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) })); $('#character-modal').close(); } catch (error) { alert(error.message); } }
function openWorldModal() { const form = $('#world-form'); Object.entries(state.world).forEach(([key, value]) => { form.elements[key].value = value; }); $('#world-modal').showModal(); }
async function saveWorld() { const form = $('#world-form'); if (!form.reportValidity()) return; try { setState(await api('/api/world', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(form))) })); $('#world-modal').close(); } catch (error) { alert(error.message); } }

$('#advance-button').onclick = advanceTurn;
$('#auto-button').onclick = () => { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } else autoTimer = setInterval(advanceTurn, 5000); render(); };
$('#open-character-modal').onclick = () => openCharacterModal(); $('#open-world-modal').onclick = openWorldModal;
$('#event-form').onsubmit = (event) => { event.preventDefault(); addEvent($('#event-input').value); $('#event-input').value = ''; };
$('#character-form').onsubmit = (event) => { event.preventDefault(); saveCharacter(); }; $('#world-form').onsubmit = (event) => { event.preventDefault(); saveWorld(); };
$('#ai-character-button').onclick = () => { const f = $('#character-form'); f.elements.name.value = '아린'; f.elements.role.value = '별자리 연구자'; f.elements.personality.value = '침착함, 예리함, 은근한 유머'; f.elements.speechStyle.value = '낮고 느긋한 말투로 핵심을 짚는다.'; f.elements.goal.value = '자신만의 단서를 해독한다.'; f.elements.secret.value = '사건과 관련된 오래된 약속을 알고 있다.'; };
document.querySelectorAll('[data-close]').forEach((button) => { button.onclick = () => $(`#${button.dataset.close}`).close(); });
$('#reset-button').style.display = 'none';
api('/api/state').then(setState).catch((error) => { $('#save-status').textContent = 'DB 설정 필요'; alert(`${error.message}\n\nREADME의 PostgreSQL 설정 단계를 실행하세요.`); });