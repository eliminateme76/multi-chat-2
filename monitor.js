const stages = [
  ['state_load', 'DB STATE', '상태 조회'], ['director_plan', 'DIRECTOR', '전개 판단'], ['speaker_select', 'ROUTER', '화자 선택'], ['memory_retrieve', 'MEMORY', '기억 검색'],
  ['context_build', 'CONTEXT', '프롬프트 조립'], ['queue_wait', 'QUEUE', '요청 대기'], ['app_server_ready', 'APP SERVER', '프로세스 준비'],
  ['thread_start', 'THREAD', 'Thread 생성'], ['model_generate', 'MODEL', '응답 생성'], ['output_validate', 'VALIDATOR', '출력 검증'], ['db_transaction', 'DATABASE', '상태 저장']
];
const WATERFALL_SCALE_MS = 60_000;
let runtime = { resources: {}, runs: [] };
let projects = [];
let threads = [];
let projectId = new URLSearchParams(location.search).get('project');
let selectedRunId;
let selectedStageName;
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const ms = (value) => value == null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value}ms`;
const selectedRuns = () => runtime.runs.filter((run) => !projectId || run.projectId === projectId);
const currentRun = () => selectedRuns().find((run) => run.id === selectedRunId) || selectedRuns()[0];

function render() {
  const run = currentRun();
  const appServer = runtime.resources?.appServer || {};
  $('#connection-state').textContent = 'LIVE';
  $('#connection-state').className = 'status-completed';
  $('#run-status').textContent = run ? statusText(run.status) : '대기 중';
  $('#run-status').className = run ? `status-${run.status}` : '';
  $('#run-detail').textContent = run ? `${runLabel(run.type)}${run.metadata?.activeCharacterName || run.metadata?.characterName ? ` · 캐릭터 ${run.metadata.activeCharacterName || run.metadata.characterName}` : ''}${run.metadata?.directorAction ? ` · ${run.metadata.directorAction}` : ''}${run.metadata?.beatPhase ? ` · ${run.metadata.beatPhase}/${run.metadata.beatOutcome}` : ''}${run.metadata?.tensionAfter != null ? ` · 긴장 ${run.metadata.tensionBefore ?? '?'}→${run.metadata.tensionAfter} ${run.metadata.tensionDirection || ''}` : ''}` : '새 요청을 기다리고 있습니다';
  $('#total-duration').textContent = run ? ms(run.durationMs ?? Date.now() - Date.parse(run.startedAt)) : '—';
  const completedStages = run?.stages.filter((stage) => stage.durationMs != null) || [];
  const bottleneck = completedStages.toSorted((a, b) => b.durationMs - a.durationMs)[0];
  const runningStage = run?.stages.findLast((stage) => stage.status === 'running');
  $('#current-stage').textContent = runningStage ? labelFor(runningStage.name) : run?.status === 'completed' ? '모든 단계 완료' : run?.status === 'failed' ? '실행 실패' : '대기';
  $('#current-stage').className = runningStage ? 'status-running' : run?.status === 'completed' ? 'status-completed' : run?.status === 'failed' ? 'status-failed' : '';
  $('#current-stage-time').textContent = runningStage ? `${ms(Date.now() - Date.parse(runningStage.startedAt))} 진행 중` : run ? `최근 실행 ${new Date(run.startedAt).toLocaleTimeString()}` : '—';
  $('#bottleneck').textContent = bottleneck ? `${labelFor(bottleneck.name)} · ${ms(bottleneck.durationMs)}` : '—';
  $('#app-server-state').textContent = appServer.status || 'idle';
  $('#app-server-state').className = appServer.status === 'ready' ? 'status-completed' : appServer.status === 'stopped' ? 'status-failed' : 'status-running';
  $('#app-server-detail').textContent = appServer.pid ? `PID ${appServer.pid}` : '';
  renderActiveThread();
  renderPipeline(run); renderWaterfall(run, bottleneck); renderHistory(); renderThreads(); renderTraceTimeline();
  showNode(selectedStageName || runningStage?.name || bottleneck?.name, run);
}

function allTrackedThreads() {
  const tracked = new Map(threads.map((thread) => [thread.threadId, thread]));
  for (const observed of observedThreads()) {
    const persistent = tracked.get(observed.threadId);
    tracked.set(observed.threadId, persistent
      ? { ...observed, ...persistent, status: observed.status === 'running' ? 'running' : persistent.status }
      : observed);
  }
  return [...tracked.values()];
}

function renderActiveThread() {
  const runningThreadId = selectedRuns().flatMap((item) => item.stages || []).findLast((stage) => stage.status === 'running' && stage.metadata?.threadId)?.metadata?.threadId;
  const trackedThreads = allTrackedThreads();
  const active = trackedThreads.find((thread) => thread.threadId === runningThreadId) || trackedThreads.find((thread) => thread.status === 'running');
  const run = selectedRuns().find((item) => item.status === 'running');
  const banner = $('#active-call-banner');
  const title = $('#active-thread-title');
  const detail = $('#active-thread-detail');
  if (!active) {
    if (run?.metadata?.activeAgentName) {
      const runningStage = run.stages?.findLast((stage) => stage.status === 'running');
      banner.dataset.active = 'true';
      title.textContent = run.metadata.activeAgentType === 'director' ? '월드 디렉터' : run.metadata.activeAgentType === 'world_builder' ? '월드 설계자' : `캐릭터 · ${run.metadata.activeAgentName}`;
      title.className = 'status-running';
      detail.textContent = `${run.metadata.activePhase || '분석 중'} · ${runningStage ? `${labelFor(runningStage.name)} ${ms(Date.now() - Date.parse(runningStage.startedAt))}` : '호출 준비 중'}${run.metadata.activeModel ? ` · ${run.metadata.activeModel}${run.metadata.activeEffort ? ` · ${run.metadata.activeEffort}` : ''}` : ''}${run.metadata.activeThreadId ? ` · ${run.metadata.activeThreadId}` : ''}`;
      return;
    }
    banner.dataset.active = 'false';
    title.textContent = '대기';
    title.className = '';
    detail.textContent = '실행 중인 Codex 호출이 없습니다';
    return;
  }
  const stage = selectedRuns().flatMap((item) => item.stages || []).findLast((item) => item.status === 'running' && item.metadata?.threadId === active.threadId);
  const stageDuration = stage ? ms(Date.now() - Date.parse(stage.startedAt)) : null;
  const compactId = active.threadId.length > 22 ? `${active.threadId.slice(0, 11)}…${active.threadId.slice(-8)}` : active.threadId;
  banner.dataset.active = 'true';
  title.textContent = active.kind === 'director' ? '월드 디렉터' : active.kind === 'world_builder' ? '월드 설계자' : `캐릭터 · ${active.name.replace(/^캐릭터 응답 · /, '')}`;
  title.className = 'status-running';
  detail.textContent = `${stage ? `${labelFor(stage.name)} · ${stageDuration} 진행 중` : 'Codex 호출 진행 중'} · ${active.detail || active.model || '기본 모델'}${active.effort ? ` · ${active.effort}` : ''} · ${compactId}`;
}

function renderPipeline(run) {
  $('#pipeline').innerHTML = stages.map(([name, eyebrow, label], index) => {
    const stage = run?.stages.findLast((item) => item.name === name);
    const status = stage?.status || (name === 'queue_wait' && run?.status === 'running' ? 'queued' : 'idle');
    return `<button class="runtime-node ${status}" data-stage="${name}" data-step="${String(index + 1).padStart(2, '0')}"><span>${eyebrow}</span><strong>${label}</strong><small>${stage ? `${statusText(status)} · ${ms(stage.durationMs ?? Date.now() - Date.parse(stage.startedAt))}` : '대기'}</small></button>`;
  }).join('');
  document.querySelectorAll('[data-stage]').forEach((node) => { node.onclick = () => { selectedStageName = node.dataset.stage; showNode(selectedStageName, run); }; });
}

function showNode(name, run) {
  if (!name) { $('#node-detail').innerHTML = '<span>NODE DETAIL</span><p>실행을 기다리고 있습니다.</p>'; return; }
  const stage = run?.stages.findLast((item) => item.name === name);
  if (!stage) { $('#node-detail').innerHTML = `<span>NODE DETAIL</span><p>${esc(labelFor(name))}: 아직 실행 기록이 없습니다.</p>`; return; }
  const metadata = Object.entries(stage.metadata || {}).map(([key, value]) => `${key}: ${value}`).join('\n');
  $('#node-detail').innerHTML = `<span>NODE DETAIL · ${esc(labelFor(name))}</span><p>상태: ${esc(stage.status)}\n소요시간: ${ms(stage.durationMs ?? Date.now() - Date.parse(stage.startedAt))}${metadata ? `\n${esc(metadata)}` : ''}</p>`;
}

function renderWaterfall(run, bottleneck) {
  if (!run?.stages.length) { $('#waterfall').innerHTML = '<div class="empty">아직 실행 기록이 없습니다.</div>'; return; }
  $('#waterfall').innerHTML = run.stages.map((stage) => {
    const stageDuration = stage.durationMs ?? Date.now() - Date.parse(stage.startedAt);
    const width = Math.min(100, Math.max(0.5, (stageDuration / WATERFALL_SCALE_MS) * 100));
    return `<div class="waterfall-row ${stage.status} ${stage.id === bottleneck?.id ? 'bottleneck' : ''}"><span>${esc(labelFor(stage.name))}</span><div class="waterfall-track" title="고정 60초 기준"><div class="waterfall-bar" style="width:${width}%"></div></div><em>${ms(stageDuration)}</em></div>`;
  }).join('');
}

function renderHistory() {
  const runs = selectedRuns().slice(0, 20);
  $('#run-history').innerHTML = runs.length ? runs.map((run) => `<div class="history-item ${run.id === currentRun()?.id ? 'selected' : ''}" data-run="${run.id}"><div><strong>${runLabel(run.type)}</strong><span class="status-${run.status}">${statusText(run.status)}</span></div><small>${new Date(run.startedAt).toLocaleTimeString()} · ${ms(run.durationMs)}${run.metadata?.characterName ? ` · ${esc(run.metadata.characterName)}` : ''}</small></div>`).join('') : '<div class="empty">이 세계관의 실행 기록이 없습니다.</div>';
  document.querySelectorAll('[data-run]').forEach((item) => { item.onclick = () => { selectedRunId = item.dataset.run; selectedStageName = null; render(); }; });
}

function renderThreads() {
  const transientThreads = observedThreads();
  const allThreads = allTrackedThreads();
  const running = allThreads.filter((thread) => thread.status === 'running').length;
  $('#thread-count').textContent = `${allThreads.length}개${running ? ` · ${running} 실행 중` : ''}`;
  const renderItem = (thread) => {
    const compactId = thread.threadId.length > 22 ? `${thread.threadId.slice(0, 11)}…${thread.threadId.slice(-8)}` : thread.threadId;
    const status = thread.conversationIdle ? '대화 종료' : ({ running: '실행 중', idle: '대기', completed: '일회성 완료', failed: '실패' })[thread.status] || '대기';
    const statusClass = thread.status === 'idle' ? 'completed' : thread.status;
    const owner = thread.kind === 'director' ? '월드 디렉터' : thread.kind === 'world_builder' ? '월드 설계자' : thread.kind === 'character' ? `캐릭터 · ${thread.name}` : thread.name;
    const usage = thread.turnCount != null ? ` · ${thread.turnCount}턴${Number(thread.contextTokens || 0) ? ` · 문맥 ${Number(thread.contextTokens).toLocaleString()} tokens` : ''}${thread.rolloverRequired ? ' · 다음 호출 교체' : ''}` : '';
    const runtime = `${thread.detail || thread.model || '기본 모델'}${thread.effort ? ` · ${thread.effort}` : ''}${usage}`;
    const detail = thread.kind === 'character' ? `캐릭터 스레드 · ${runtime}${thread.conversationIdle && thread.idleReason ? ` · ${thread.idleReason}` : ''}` : runtime;
    return `<div class="thread-item ${thread.status}"><div><strong>${esc(owner)}</strong><span class="status-${statusClass}">${status}</span></div><code title="${esc(thread.threadId)}">${esc(compactId)}</code><small>${esc(detail)}</small></div>`;
  };
  const persistent = threads.length ? `<div class="thread-section">영속 스레드 · 캐릭터 / 디렉터 / 월드 설계자</div>${allThreads.filter((thread) => threads.some((persistentThread) => persistentThread.threadId === thread.threadId)).map(renderItem).join('')}` : '';
  const transient = transientThreads.filter((thread) => !threads.some((persistentThread) => persistentThread.threadId === thread.threadId));
  const observed = transient.length ? `<div class="thread-section">최근 일회성 호출 · 서버 재시작 전 기록</div>${transient.map(renderItem).join('')}` : '';
  $('#thread-list').innerHTML = persistent || observed || '<div class="empty">아직 관측된 Codex 스레드가 없습니다.</div>';
}

function observedThreads() {
  const observed = new Map();
  for (const run of selectedRuns()) {
    for (const stage of run.stages || []) {
      if (!['thread_start', 'thread_resume'].includes(stage.name) || !stage.metadata?.threadId) continue;
      if (observed.has(stage.metadata.threadId)) continue;
      observed.set(stage.metadata.threadId, {
        threadId: stage.metadata.threadId,
        kind: stage.metadata.usage?.startsWith('캐릭터 응답 · ') ? 'character' : stage.metadata.usage?.includes('월드 설계자') ? 'world_builder' : stage.metadata.usage?.includes('디렉터') ? 'director' : 'transient',
        name: stage.metadata.usage?.replace(/^캐릭터 응답 · /, '') || 'Codex 호출',
        detail: `${stage.name === 'thread_resume' ? '기존 스레드 재개' : '새 스레드'} · ${stage.metadata.model || '기본 모델'}`,
        status: run.status === 'running' ? 'running' : run.status === 'failed' ? 'failed' : 'completed'
      });
    }
  }
  return [...observed.values()].slice(0, 20);
}

function renderTraceTimeline() {
  const runs = selectedRuns().slice(0, 200).toReversed();
  renderTraceChart(runs);
  $('#trace-timeline').innerHTML = runs.length ? runs.map((run) => {
    const total = run.durationMs ?? Date.now() - Date.parse(run.startedAt);
    const stageBlocks = (run.stages || []).map((stage) => {
      const stageDuration = stage.durationMs ?? Date.now() - Date.parse(stage.startedAt);
      const width = Math.max(36, Math.round(stageDuration / 1000 * 18));
      const stageClass = stage.name.replaceAll('_', '-');
      return `<div class="trace-stage ${stageClass} ${stage.status}" style="width:${width}px" title="${esc(labelFor(stage.name))} · ${ms(stageDuration)}"><strong>${esc(labelFor(stage.name))}</strong><span>${ms(stageDuration)}</span></div>`;
    }).join('');
    const owner = run.metadata?.activeCharacterName || run.metadata?.characterName;
    return `<article class="trace-run ${run.status}"><div class="trace-run-meta"><strong>${new Date(run.startedAt).toLocaleTimeString()} · ${esc(runLabel(run.type))}${owner ? ` · 캐릭터 ${esc(owner)}` : ''}</strong><span class="status-${run.status}">${statusText(run.status)} · ${ms(total)}</span></div><div class="trace-stages">${stageBlocks || '<span class="trace-empty">단계 대기 중</span>'}</div></article>`;
  }).join('') : '<div class="empty">실행이 시작되면 시간순 Trace가 여기에 계속 추가됩니다.</div>';
}

function renderTraceChart(runs) {
  const chart = $('#trace-chart');
  if (!runs.length) { chart.innerHTML = '<div class="empty">실행이 쌓이면 소요 시간 추세가 표시됩니다.</div>'; return; }
  const visibleRuns = runs.slice(-24);
  const stageClass = (name) => name.replaceAll('_', '-');
  const runData = visibleRuns.map((run) => ({
    run,
    stages: (run.stages || []).map((stage) => ({ ...stage, elapsed: Math.max(1, stage.durationMs ?? Date.now() - Date.parse(stage.startedAt)) })),
    total: Math.max(1, run.durationMs ?? Date.now() - Date.parse(run.startedAt))
  }));
  const maximum = Math.max(1, ...runData.map((item) => item.total));
  const bars = runData.map(({ run, stages, total }) => {
    const measured = Math.max(1, stages.reduce((sum, stage) => sum + stage.elapsed, 0));
    const segments = stages.map((stage) => {
      const ratio = stage.elapsed / measured * 100;
      return `<i class="trace-bar-segment ${stageClass(stage.name)} ${stage.status}" style="flex-grow:${stage.elapsed}" title="${esc(labelFor(stage.name))} · ${ms(stage.elapsed)} · ${ratio.toFixed(1)}%"></i>`;
    }).join('');
    const owner = run.metadata?.activeCharacterName || run.metadata?.characterName || '';
    const height = Math.max(10, total / maximum * 160);
    return `<div class="trace-bar-run ${run.status}" title="${esc(`${runLabel(run.type)}${owner ? ` · ${owner}` : ''}`)}"><span>${ms(total)}</span><div class="trace-bar-stack" style="height:${height.toFixed(1)}px">${segments || '<i class="trace-bar-segment empty"></i>'}</div><small>${new Date(run.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></div>`;
  }).join('');
  chart.innerHTML = `<div class="trace-stage-legend"><span>최대 ${ms(maximum)}</span><span class="context-build">컨텍스트</span><span class="thread-start">스레드</span><span class="model-generate">모델</span><span class="output-validate">검증</span><span class="db-transaction">DB</span><span class="other">기타</span></div><div class="trace-bars">${bars}</div>`;
}

async function refreshThreads() {
  if (!projectId) return;
  const response = await fetch(`/api/runtime/threads?projectId=${encodeURIComponent(projectId)}`);
  if (!response.ok) throw new Error('스레드 상태를 불러오지 못했습니다.');
  threads = (await response.json()).threads;
}

function labelFor(name) { return stages.find(([key]) => key === name)?.[2] || name; }
function runLabel(type) { return ({ turn: '단일 턴 생성', progression: '월드 진행', character_suggestion: '캐릭터 추천', event_suggestions: '사건 추천', director_event: '디렉터 사건 적용', story_repair: '이야기 상태 진단', world_draft: '월드 초안 설계', world_create: '새 월드 생성' })[type] || type; }
function statusText(status) { return ({ running: '실행 중', completed: '완료', failed: '실패', queued: '대기 중', idle: '대기' })[status] || status; }

async function initialize() {
  projects = await (await fetch('/api/projects')).json();
  if (!projects.some((project) => project.id === projectId)) projectId = projects[0]?.id;
  $('#monitor-project').innerHTML = projects.map((project) => `<option value="${esc(project.id)}">${esc(project.title)}</option>`).join('');
  $('#monitor-project').value = projectId;
  $('#monitor-project').onchange = async (event) => { projectId = event.target.value; selectedRunId = null; selectedStageName = null; const url = new URL(location.href); url.searchParams.set('project', projectId); history.replaceState({}, '', url); await refreshThreads(); render(); };
  runtime = await (await fetch('/api/runtime/snapshot')).json();
  await refreshThreads();
  render();
  const events = new EventSource('/api/runtime/events');
  events.addEventListener('snapshot', (event) => { runtime = JSON.parse(event.data); render(); });
  events.addEventListener('runtime', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'run') {
      const index = runtime.runs.findIndex((run) => run.id === message.payload.id);
      if (index >= 0) runtime.runs[index] = message.payload; else runtime.runs.unshift(message.payload);
    } else if (message.type === 'resource') runtime.resources[message.payload.name] = message.payload.value;
    render();
  });
  events.onerror = () => { $('#connection-state').textContent = '재연결 중'; $('#connection-state').className = 'status-failed'; };
  setInterval(() => { if (currentRun()?.status === 'running') render(); }, 500);
  setInterval(() => { refreshThreads().then(render).catch(() => {}); }, 2000);
}
initialize().catch((error) => { $('#connection-state').textContent = '연결 실패'; document.body.insertAdjacentHTML('beforeend', `<pre>${esc(error.message)}</pre>`); });
