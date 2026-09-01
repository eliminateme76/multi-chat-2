import { spawn } from 'node:child_process';
import { buildCharacterSuggestionPrompt, buildCharacterTurnPrompt, buildEventSuggestionsPrompt } from './context-builder.js';
import { endStage, failStage, recordStage, setRuntimeResource, startStage } from './runtime-telemetry.js';

const CODEX_MODEL = process.env.CODEX_MODEL || 'gpt-5.6-sol';
const TIMEOUT_MS = Number(process.env.CODEX_TURN_TIMEOUT_MS || 120000);
const APP_SERVER_CODEX_HOME = process.env.SCENEWEAVER_CODEX_HOME?.trim();

const turnSchema = {
  type: 'object',
  properties: {
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
  required: ['dialogue', 'action', 'emotion', 'memory', 'memoryImportance', 'relationshipChanges', 'sceneSignal'],
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

  async ensureThread(existingThreadId, model, runId, usage) {
    await this.ready;
    if (existingThreadId && this.loadedThreads.has(existingThreadId)) return { threadId: existingThreadId, reused: true };
    const stage = startStage(runId, existingThreadId ? 'thread_resume' : 'thread_start', { usage });
    try {
      if (existingThreadId) {
        await this.request('thread/resume', { threadId: existingThreadId });
        this.loadedThreads.add(existingThreadId);
        endStage(runId, stage, { threadId: existingThreadId, model, usage });
        return { threadId: existingThreadId, reused: true };
      }
      const started = await this.request('thread/start', { model, cwd: process.cwd(), approvalPolicy: 'never', sandbox: 'read-only', serviceName: 'sceneweaver' });
      const threadId = started?.thread?.id;
      if (!threadId) throw new Error('Codex app-server did not return a thread id.');
      this.loadedThreads.add(threadId);
      endStage(runId, stage, { threadId, model, usage });
      return { threadId, reused: false };
    } catch (error) {
      failStage(runId, stage, error);
      if (existingThreadId) return this.ensureThread(null, model, runId, usage);
      throw error;
    }
  }

  async runTurn(prompt, outputSchema, runId, { threadId: existingThreadId = null, model = CODEX_MODEL, persistent = false, usage = 'Codex 호출' } = {}) {
    const ensured = await this.ensureThread(existingThreadId, model, runId, usage);
    const threadId = ensured.threadId;
    if (!threadId) throw new Error('Codex app-server did not return a thread id.');
    const modelStage = startStage(runId, 'model_generate', { threadId, usage });
    const completion = new Promise((resolve, reject) => { this.activeTurn = { resolve, reject }; });
    try {
      await this.request('turn/start', { threadId, model, cwd: process.cwd(), approvalPolicy: 'never', sandbox: 'read-only', input: [{ type: 'text', text: prompt }], outputSchema });
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
  const contextStage = startStage(context.runId, 'context_build');
  const prompt = buildCharacterTurnPrompt(context);
  endStage(context.runId, contextStage, { promptChars: prompt.length, publicLogs: Math.min(6, context.state.logs.length), privateMemories: context.memories.length });
  return runCodexStructured({
    prompt, outputSchema: turnSchema, label: `캐릭터 응답 · ${context.character.name}`, runId: context.runId,
    thread: { threadId: context.character.activeThreadId, model: context.character.effectiveModel || CODEX_MODEL, persistent: true },
    validate: (result) => {
      if (typeof result.emotion !== 'string' || !result.emotion.trim()) throw new Error('missing emotion');
      if (typeof result.dialogue !== 'string' || (context.state.presentationMode === 'chat' && !result.dialogue.trim())) throw new Error('missing dialogue');
      if (typeof result.action !== 'string' || (context.state.presentationMode !== 'chat' && !result.action.trim() && !result.dialogue.trim())) throw new Error('missing response content');
      for (const field of ['dialogue', 'action', 'emotion']) result[field] = result[field].trim();
      if (typeof result.memory !== 'string') throw new Error('invalid memory');
      result.memory = result.memory.trim();
      if (!Number.isInteger(result.memoryImportance) || result.memoryImportance < 0 || result.memoryImportance > 100) throw new Error('invalid memoryImportance');
      if (!Array.isArray(result.relationshipChanges)) throw new Error('invalid relationshipChanges');
      if (!['continue', 'stalled', 'complete'].includes(result.sceneSignal)) throw new Error('invalid sceneSignal');
    }
  });
}

export function generateResponderSelection(prompt, runId) {
  return runCodexStructured({ prompt, outputSchema: responderSchema, label: 'responder selection', runId,
    validate: (result) => { if (!Array.isArray(result.responders)) throw new Error('invalid responders'); }
  });
}

export function generateCharacterSuggestion(state, runId) {
  const contextStage = startStage(runId, 'context_build');
  const prompt = buildCharacterSuggestionPrompt(state);
  endStage(runId, contextStage, { promptChars: prompt.length, publicLogs: Math.min(6, state.logs.length), characters: state.characters.length });
  return runCodexStructured({
    prompt, outputSchema: suggestionSchema, label: 'character suggestion', runId,
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
    prompt, outputSchema: eventSuggestionsSchema, label: 'event suggestions', runId,
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
