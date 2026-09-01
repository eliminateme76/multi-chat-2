import { spawn } from 'node:child_process';
import { buildCharacterSuggestionPrompt, buildCharacterTurnPrompt, buildEventSuggestionsPrompt, buildDirectorEventApplyPrompt, buildDirectorSceneTransitionPrompt } from './context-builder.js';
import { endStage, failStage, recordStage, setRuntimeResource, startStage, updateRunMetadata } from './runtime-telemetry.js';

const CODEX_MODEL = process.env.CODEX_MODEL || 'gpt-5.6-sol';
const TIMEOUT_MS = Number(process.env.CODEX_TURN_TIMEOUT_MS || 120000);
const APP_SERVER_CODEX_HOME = process.env.SCENEWEAVER_CODEX_HOME?.trim();

const turnSchema = {
  type: 'object',
  properties: {
    shouldRespond: { type: 'boolean' }, silenceReason: { type: 'string' },
    dialogue: { type: 'string' }, action: { type: 'string' }, emotion: { type: 'string' },
    memory: { type: 'string' }, memoryImportance: { type: 'integer', minimum: 0, maximum: 100 },
    relationshipChanges: {
      type: 'array', maxItems: 3,
      items: {
        type: 'object',
        properties: { targetId: { type: 'string' }, delta: { type: 'integer', minimum: -10, maximum: 10 } },
        required: ['targetId', 'delta'], additionalProperties: false
      }
    },
    sceneSignal: { type: 'string', enum: ['continue', 'stalled', 'complete'] }
  },
  required: ['shouldRespond', 'silenceReason', 'dialogue', 'action', 'emotion', 'memory', 'memoryImportance', 'relationshipChanges', 'sceneSignal'],
  additionalProperties: false
};

const responderSchema = {
  type: 'object', properties: {
    responders: { type: 'array', items: { type: 'object', properties: { characterId: { type: 'string' }, reason: { type: 'string' } }, required: ['characterId','reason'], additionalProperties: false } }
  }, required: ['responders'], additionalProperties: false
};

const suggestionSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' }, role: { type: 'string' }, gender: { type: 'string', enum: ['여성', '남성', '논바이너리', '성별 없음'] }, personality: { type: 'string' },
    speechStyle: { type: 'string' }, goal: { type: 'string' }, secret: { type: 'string' }
  },
  required: ['name', 'role', 'gender', 'personality', 'speechStyle', 'goal', 'secret'],
  additionalProperties: false
};

const eventSuggestionsSchema = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array', minItems: 10, maxItems: 10,
      items: {
        type: 'object',
        properties: { category: { type: 'string', enum: ['일상', '관계', '연락', '선택', '발견', '돌발', '시간 전환', '분위기'] }, text: { type: 'string' }, time: { type: 'string' } },
        required: ['category', 'text', 'time'], additionalProperties: false
      }
    }
  },
  required: ['suggestions'], additionalProperties: false
};

const directorEventPlanSchema = {
  type: 'object',
  properties: {
    applyMode: { type: 'string', enum: ['APPEND_EVENT', 'CREATE_SCENE'] }, text: { type: 'string' }, eventType: { type: 'string', enum: ['일상', '관계', '연락', '선택', '발견', '돌발', '시간 전환', '분위기', '일반'] }, time: { type: 'string' },
    location: { type: 'string' }, mood: { type: 'string' }, description: { type: 'string' }
  },
  required: ['applyMode', 'text', 'eventType', 'time', 'location', 'mood', 'description'], additionalProperties: false
};

let appServer;
let requestQueue = Promise.resolve();

class PersistentAppServer {
  constructor() {
    const env = { ...process.env };
    if (APP_SERVER_CODEX_HOME) env.CODEX_HOME = APP_SERVER_CODEX_HOME;
    this.child = spawn('codex', ['app-server'], { cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'] });
    setRuntimeResource('appServer', { status: 'starting', pid: this.child.pid, startedAt: new Date().toISOString() });
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.activeTurn = null;
    this.loadedThreads = new Set();
    this.closed = false;
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.on('data', () => {});
    this.child.on('error', (error) => this.destroy(new Error(`Could not start Codex app-server: ${error.message}`)));
    this.child.on('exit', (code, signal) => {
      if (!this.closed) this.destroy(new Error(`Codex app-server exited unexpectedly (${signal || code}).`));
    });
    this.ready = this.initialize().then(() => {
      setRuntimeResource('appServer', { status: 'ready', pid: this.child.pid });
    });
  }

  send(message) {
    if (this.closed || !this.child.stdin.writable) throw new Error('Codex app-server is not available.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.send({ id, method, params }); } catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'sceneweaver', version: '0.1.0' }, capabilities: { optOutNotificationMethods: ['item/agentMessage/delta'] } });
    this.send({ method: 'initialized', params: {} });
  }

  onData(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`Codex app-server: ${message.error.message || 'unknown error'}`));
        else pending.resolve(message.result);
      } else if (message.method === 'turn/completed' && this.activeTurn) {
        const activeTurn = this.activeTurn;
        this.activeTurn = null;
        activeTurn.resolve(message.params?.turn);
      }
    }
  }

  async ensureThread(existingThreadId, model, effort, runId, usage) {
    await this.ready;
    if (existingThreadId && this.loadedThreads.has(existingThreadId)) return { threadId: existingThreadId, reused: true };
    const stage = startStage(runId, existingThreadId ? 'thread_resume' : 'thread_start', { usage });
    try {
      if (existingThreadId) {
        await this.request('thread/resume', { threadId: existingThreadId });
        this.loadedThreads.add(existingThreadId);
        endStage(runId, stage, { threadId: existingThreadId, model, effort, usage });
        return { threadId: existingThreadId, reused: true };
      }
      const started = await this.request('thread/start', { model, cwd: process.cwd(), approvalPolicy: 'never', sandbox: 'read-only', serviceName: 'sceneweaver' });
      const threadId = started?.thread?.id;
      if (!threadId) throw new Error('Codex app-server did not return a thread id.');
      this.loadedThreads.add(threadId);
      endStage(runId, stage, { threadId, model, effort, usage });
      return { threadId, reused: false };
    } catch (error) {
      failStage(runId, stage, error);
      if (existingThreadId) return this.ensureThread(null, model, effort, runId, usage);
      throw error;
    }
  }

  async runTurn(prompt, outputSchema, runId, { threadId: existingThreadId = null, model = CODEX_MODEL, effort = 'medium', persistent = false, usage = 'Codex 호출' } = {}) {
    const ensured = await this.ensureThread(existingThreadId, model, effort, runId, usage);
    const threadId = ensured.threadId;
    if (!threadId) throw new Error('Codex app-server did not return a thread id.');
    const modelStage = startStage(runId, 'model_generate', { threadId, model, effort, usage });
    const completion = new Promise((resolve, reject) => { this.activeTurn = { resolve, reject }; });
    try {
      await this.request('turn/start', { threadId, model, effort, cwd: process.cwd(), approvalPolicy: 'never', sandbox: 'read-only', input: [{ type: 'text', text: prompt }], outputSchema });
      const turn = await completion;
      endStage(runId, modelStage, { outputItems: turn?.items?.length || 0, usage });
      return { turn, threadId, reused: ensured.reused };
    } catch (error) {
      if (this.activeTurn) this.activeTurn = null;
      failStage(runId, modelStage, error);
      throw error;
    } finally {
      if (!persistent) await this.cleanupThread(threadId);
    }
  }

  async cleanupThread(threadId) {
    if (!threadId || this.closed) return;
    const failures = [];
    for (const method of ['thread/unsubscribe', 'thread/delete']) {
      if (this.closed) break;
      try { await this.request(method, { threadId }); } catch (error) { failures.push(`${method}: ${error.message}`); }
    }
    if (failures.length) console.warn(`Codex thread cleanup incomplete (${threadId}): ${failures.join('; ')}`);
  }

  destroy(error = new Error('Codex app-server stopped.')) {
    if (this.closed) return;
    this.closed = true;
    if (appServer === this) appServer = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.activeTurn?.reject(error);
    this.activeTurn = null;
    if (!this.child.killed) this.child.kill();
    setRuntimeResource('appServer', { status: 'stopped', pid: null, stoppedAt: new Date().toISOString(), error: error.message });
  }
}

function getAppServer() {
  const reused = Boolean(appServer && !appServer.closed);
  if (!reused) appServer = new PersistentAppServer();
  return { client: appServer, reused };
}

export async function listCodexModels() {
  const { client } = getAppServer();
  await client.ready;
  const result = await client.request('model/list', { limit: 100, includeHidden: false });
  return (result?.data || []).map((item) => ({
    id: item.model || item.id,
    name: item.displayName || item.model || item.id,
    description: item.description || '',
    defaultEffort: item.defaultReasoningEffort,
    efforts: (item.supportedReasoningEfforts || []).map((option) => option.reasoningEffort)
  }));
}

async function executeStructured({ prompt, outputSchema, validate, label, runId, thread }) {
  const appServerStage = startStage(runId, 'app_server_ready');
  const { client, reused } = getAppServer();
  let timer;
  try {
    await client.ready;
    endStage(runId, appServerStage, { reused, pid: client.child.pid });
    const turn = await Promise.race([
      client.runTurn(prompt, outputSchema, runId, { ...thread, usage: label }),
      new Promise((_, reject) => { timer = setTimeout(() => { const error = new Error(`Codex ${label} timed out after ${TIMEOUT_MS / 1000} seconds.`); client.destroy(error); reject(error); }, TIMEOUT_MS); })
    ]);
    if (turn?.turn?.status !== 'completed') throw new Error(`Codex ${label} failed: ${turn?.turn?.error?.message || turn?.turn?.status || 'unknown error'}`);
    const validationStage = startStage(runId, 'output_validate');
    const text = turn.turn.items?.find((item) => item.type === 'agentMessage')?.text;
    try {
      const result = JSON.parse(text);
      validate(result);
      endStage(runId, validationStage, { responseChars: text?.length || 0 });
      return { ...result, threadId: turn.threadId, threadReused: turn.reused };
    } catch (error) { failStage(runId, validationStage, error); throw error; }
  } catch (error) {
    if (appServerStage) failStage(runId, appServerStage, error);
    if (error instanceof SyntaxError) throw new Error(`Codex returned invalid ${label} JSON: ${error.message}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function runCodexStructured(options) {
  const queuedAt = Date.now();
  const operation = requestQueue.then(() => {
    recordStage(options.runId, 'queue_wait', Date.now() - queuedAt);
    return executeStructured(options);
  });
  requestQueue = operation.catch(() => {});
  return operation;
}

process.once('exit', () => appServer?.destroy());

export function generateCodexTurn(context) {
  updateRunMetadata(context.runId, { activeAgentType: 'character', activeAgentName: context.character.name, activePhase: '캐릭터 응답 생성', activeCharacterId: context.character.id, activeCharacterName: context.character.name, activeThreadId: context.character.activeThreadId || null, activeModel: context.character.effectiveModel || CODEX_MODEL, activeEffort: context.character.effectiveReasoningEffort || 'medium' });
  const contextStage = startStage(context.runId, 'context_build');
  const prompt = buildCharacterTurnPrompt(context);
  endStage(context.runId, contextStage, { promptChars: prompt.length, publicLogs: Math.min(6, context.state.logs.length), privateMemories: context.memories.length });
  return runCodexStructured({
    prompt, outputSchema: turnSchema, label: `캐릭터 응답 · ${context.character.name}`, runId: context.runId,
    thread: { threadId: context.character.activeThreadId, model: context.character.effectiveModel || CODEX_MODEL, effort: context.character.effectiveReasoningEffort || 'medium', persistent: true },
    validate: (result) => {
      if (typeof result.shouldRespond !== 'boolean' || typeof result.silenceReason !== 'string') throw new Error('invalid response decision');
      if (typeof result.emotion !== 'string' || !result.emotion.trim()) throw new Error('missing emotion');
      if (typeof result.dialogue !== 'string' || (result.shouldRespond && context.state.presentationMode === 'chat' && !result.dialogue.trim())) throw new Error('missing dialogue');
      if (typeof result.action !== 'string' || (result.shouldRespond && context.state.presentationMode !== 'chat' && !result.action.trim() && !result.dialogue.trim())) throw new Error('missing response content');
      for (const field of ['dialogue', 'action', 'emotion']) result[field] = result[field].trim();
      result.silenceReason = result.silenceReason.trim();
      if (!result.shouldRespond && context.state.presentationMode !== 'chat') throw new Error('story characters must respond');
      if (!result.shouldRespond && !result.silenceReason) throw new Error('missing silenceReason');
      if (!result.shouldRespond && (result.dialogue || result.action)) throw new Error('silent response contains public content');
      if (typeof result.memory !== 'string') throw new Error('invalid memory');
      result.memory = result.memory.trim();
      if (!Number.isInteger(result.memoryImportance) || result.memoryImportance < 0 || result.memoryImportance > 100) throw new Error('invalid memoryImportance');
      if (!Array.isArray(result.relationshipChanges)) throw new Error('invalid relationshipChanges');
      if (!['continue', 'stalled', 'complete'].includes(result.sceneSignal)) throw new Error('invalid sceneSignal');
      if (!result.shouldRespond && (result.memory || result.memoryImportance !== 0 || result.relationshipChanges.length || result.sceneSignal !== 'continue')) throw new Error('silent response contains state changes');
    }
  });
}

export function generateResponderSelection(prompt, runId) {
  return runCodexStructured({ prompt, outputSchema: responderSchema, label: '응답자 선택', runId,
    validate: (result) => { if (!Array.isArray(result.responders)) throw new Error('invalid responders'); }
  });
}

export function generateDirectorResponderSelection(prompt, runId, director) {
  updateRunMetadata(runId, { activeAgentType: 'director', activeAgentName: '월드 디렉터', activePhase: '응답자 선택', activeThreadId: director.activeThreadId || null, activeModel: director.model || CODEX_MODEL, activeEffort: director.reasoningEffort || 'high' });
  return runCodexStructured({ prompt, outputSchema: responderSchema, label: 'World Director · 응답자 선택', runId,
    thread: { threadId: director.activeThreadId, model: director.model || CODEX_MODEL, effort: director.reasoningEffort || 'high', persistent: true },
    validate: (result) => { if (!Array.isArray(result.responders)) throw new Error('invalid responders'); }
  });
}

export function generateCharacterSuggestion(state, runId) {
  const contextStage = startStage(runId, 'context_build');
  const prompt = buildCharacterSuggestionPrompt(state);
  endStage(runId, contextStage, { promptChars: prompt.length, publicLogs: Math.min(6, state.logs.length), characters: state.characters.length });
  return runCodexStructured({
    prompt, outputSchema: suggestionSchema, label: '캐릭터 추천', runId,
    thread: { model: state.aiSettings?.utility.model || CODEX_MODEL, effort: state.aiSettings?.utility.reasoningEffort || 'medium' },
    validate: (result) => {
      for (const field of ['name', 'role', 'personality', 'speechStyle', 'goal', 'secret']) {
        if (typeof result[field] !== 'string' || !result[field].trim()) throw new Error(`missing ${field}`);
        result[field] = result[field].trim();
      }
    }
  });
}

export function generateEventSuggestions(state, runId, desiredTypes = []) {
  const contextStage = startStage(runId, 'context_build');
  const prompt = buildEventSuggestionsPrompt(state, desiredTypes);
  endStage(runId, contextStage, { promptChars: prompt.length, publicLogs: Math.min(10, state.logs.length), characters: state.characters.length });
  return runCodexStructured({
    prompt, outputSchema: eventSuggestionsSchema, label: '사건 추천', runId,
    validate: (result) => {
      if (!Array.isArray(result.suggestions) || result.suggestions.length !== 10) throw new Error('invalid suggestions');
      for (const suggestion of result.suggestions) {
        for (const field of ['category', 'text', 'time']) if (typeof suggestion[field] !== 'string') throw new Error(`missing suggestion ${field}`);
        suggestion.category = suggestion.category.trim(); suggestion.text = suggestion.text.trim(); suggestion.time = suggestion.time.trim();
        if (!suggestion.category || !suggestion.text) throw new Error('empty event suggestion');
        if (suggestion.category === '시간 전환' && !suggestion.time) throw new Error('time transition is missing time');
        if (desiredTypes.length && !desiredTypes.includes(suggestion.category)) throw new Error('suggestion is outside desired event types');
      }
    }
  });
}

export function generateDirectorEventSuggestions(state, runId, desiredTypes, director) {
  updateRunMetadata(runId, { activeAgentType: 'director', activeAgentName: '월드 디렉터', activePhase: '사건 제안 생성', activeThreadId: director.activeThreadId || null, activeModel: director.model || CODEX_MODEL, activeEffort: director.reasoningEffort || 'high' });
  const contextStage = startStage(runId, 'context_build');
  const prompt = buildEventSuggestionsPrompt(state, desiredTypes, { director: true });
  endStage(runId, contextStage, { promptChars: prompt.length, publicLogs: Math.min(30, state.logs.length), director: true });
  return runCodexStructured({
    prompt, outputSchema: eventSuggestionsSchema, label: 'World Director · 사건 추천', runId,
    thread: { threadId: director.activeThreadId, model: director.model || CODEX_MODEL, effort: director.reasoningEffort || 'high', persistent: true },
    validate: (result) => {
      if (!Array.isArray(result.suggestions) || result.suggestions.length !== 10) throw new Error('invalid suggestions');
      for (const suggestion of result.suggestions) {
        for (const field of ['category', 'text', 'time']) if (typeof suggestion[field] !== 'string') throw new Error(`missing suggestion ${field}`);
        suggestion.category = suggestion.category.trim(); suggestion.text = suggestion.text.trim(); suggestion.time = suggestion.time.trim();
        if (!suggestion.category || !suggestion.text) throw new Error('empty event suggestion');
        if (suggestion.category === '시간 전환' && !suggestion.time) throw new Error('time transition is missing time');
        if (desiredTypes.length && !desiredTypes.includes(suggestion.category)) throw new Error('suggestion is outside desired event types');
      }
    }
  });
}

function validateDirectorEventPlan(result, { requireScene = false } = {}) {
  for (const field of ['text', 'eventType', 'time', 'location', 'mood', 'description']) {
    if (typeof result[field] !== 'string') throw new Error(`invalid ${field}`);
    result[field] = result[field].trim();
  }
  if (!result.text) throw new Error('empty event plan');
  if (requireScene && result.applyMode !== 'CREATE_SCENE') throw new Error('Director did not create scene transition');
}

export function generateDirectorEventApplication(state, event, runId, director) {
  updateRunMetadata(runId, { activeAgentType: 'director', activeAgentName: '월드 디렉터', activePhase: '사건 적용 판단', activeThreadId: director.activeThreadId || null, activeModel: director.model || CODEX_MODEL, activeEffort: director.reasoningEffort || 'high' });
  const prompt = buildDirectorEventApplyPrompt(state, event);
  return runCodexStructured({ prompt, outputSchema: directorEventPlanSchema, label: 'World Director · 사건 적용', runId,
    thread: { threadId: director.activeThreadId, model: director.model || CODEX_MODEL, effort: director.reasoningEffort || 'high', persistent: true },
    validate: (result) => validateDirectorEventPlan(result, { requireScene: event.forceScene })
  });
}

export function generateDirectorSceneTransition(state, runId, director) {
  updateRunMetadata(runId, { activeAgentType: 'director', activeAgentName: '월드 디렉터', activePhase: '장면 전환 판단', activeThreadId: director.activeThreadId || null, activeModel: director.model || CODEX_MODEL, activeEffort: director.reasoningEffort || 'high' });
  const prompt = buildDirectorSceneTransitionPrompt(state);
  return runCodexStructured({ prompt, outputSchema: directorEventPlanSchema, label: 'World Director · 장면 전환', runId,
    thread: { threadId: director.activeThreadId, model: director.model || CODEX_MODEL, effort: director.reasoningEffort || 'high', persistent: true },
    validate: (result) => validateDirectorEventPlan(result, { requireScene: true })
  });
}
