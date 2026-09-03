import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCharacterSuggestionPrompt, buildCharacterTurnPrompt, buildDirectorProgressionPrompt, buildEventSuggestionsPrompt, buildDirectorEventApplyPrompt, buildDirectorSceneTransitionPrompt, buildStoryRepairPrompt, buildWorldDraftPrompt } from './context-builder.js';
import { BEAT_OUTCOMES, DIRECTOR_ACTIONS, RHYTHM_PHASES, TENSION_DIRECTIONS, advanceRhythmState, applyCharacterStatePatch, applyStoryStatePatch, cleanCharacterState, cleanDramaticState, cleanRhythmState, cleanStoryState, tensionDirection } from './story-dynamics.js';
import { endStage, failStage, recordStage, setRuntimeResource, startStage, updateRunMetadata } from './runtime-telemetry.js';

const CODEX_MODEL = process.env.CODEX_MODEL || 'gpt-5.6-sol';
const TIMEOUT_MS = Number(process.env.CODEX_TURN_TIMEOUT_MS || 120000);
const APP_SERVER_CODEX_HOME = process.env.SCENEWEAVER_CODEX_HOME?.trim();
const AGENT_CWD = process.env.SCENEWEAVER_AGENT_CWD?.trim() || path.join(APP_SERVER_CODEX_HOME || os.tmpdir(), 'workspace');
const CHARACTER_THREAD_TURN_LIMIT = Number(process.env.CHARACTER_THREAD_TURN_LIMIT || 12);
const CHARACTER_THREAD_TOKEN_LIMIT = Number(process.env.CHARACTER_THREAD_TOKEN_LIMIT || 50000);
const DIRECTOR_THREAD_TURN_LIMIT = Number(process.env.DIRECTOR_THREAD_TURN_LIMIT || 8);
const DIRECTOR_THREAD_TOKEN_LIMIT = Number(process.env.DIRECTOR_THREAD_TOKEN_LIMIT || 80000);
mkdirSync(AGENT_CWD, { recursive: true, mode: 0o700 });

const shouldRollover = (owner, activeThreadId, turnCount, contextTokens, required) => Boolean(activeThreadId) && (required || Number(turnCount || 0) >= (owner === 'director' ? DIRECTOR_THREAD_TURN_LIMIT : CHARACTER_THREAD_TURN_LIMIT) || Number(contextTokens || 0) >= (owner === 'director' ? DIRECTOR_THREAD_TOKEN_LIMIT : CHARACTER_THREAD_TOKEN_LIMIT));

function directorThreadOptions(director) {
  const rollover = shouldRollover('director', director.activeThreadId, director.activeThreadTurnCount, director.activeThreadContextTokens, director.threadRolloverRequired);
  return { threadId: rollover ? null : director.activeThreadId, previousThreadId: rollover ? director.activeThreadId : null, rollover, model: director.model || CODEX_MODEL, effort: director.reasoningEffort || 'high', persistent: true };
}

const turnSchema = {
  type: 'object',
  properties: {
    shouldRespond: { type: 'boolean' }, silenceReason: { type: 'string' },
    dialogue: { type: 'string' }, action: { type: 'string' }, emotion: { type: 'string' },
    statePatch: {
      type: 'object', properties: {
        setCurrentGoal: { type: ['string','null'] }, setInternalConflict: { type: ['string','null'] },
        addBeliefs: { type: 'array', maxItems: 3, items: { type: 'string' } }, removeBeliefs: { type: 'array', maxItems: 3, items: { type: 'string' } },
        addCommitments: { type: 'array', maxItems: 3, items: { type: 'string' } }, removeCommitments: { type: 'array', maxItems: 3, items: { type: 'string' } },
        appendDevelopmentNotes: { type: 'array', maxItems: 2, items: { type: 'string' } }
      }, required: ['setCurrentGoal','setInternalConflict','addBeliefs','removeBeliefs','addCommitments','removeCommitments','appendDevelopmentNotes'], additionalProperties: false
    },
    memory: { type: 'string' }, memoryImportance: { type: 'integer', minimum: 0, maximum: 100 },
    relationshipChanges: {
      type: 'array', maxItems: 3,
      items: {
        type: 'object',
        properties: { targetId: { type: 'string' }, delta: { type: 'integer', minimum: -10, maximum: 10 }, label: { type: 'string' }, reason: { type: 'string' } },
        required: ['targetId', 'delta', 'label', 'reason'], additionalProperties: false
      }
    },
    beatOutcome: { type: 'string', enum: ['open','success','qualified_success','setback'] },
    conditionOrCost: { type: 'string' },
    sceneSignal: { type: 'string', enum: ['continue', 'stalled', 'complete'] }
  },
  required: ['shouldRespond', 'silenceReason', 'dialogue', 'action', 'emotion', 'statePatch', 'memory', 'memoryImportance', 'relationshipChanges', 'beatOutcome', 'conditionOrCost', 'sceneSignal'],
  additionalProperties: false
};

const characterStateSchema = {
  type: 'object', properties: {
    currentGoal: { type: 'string' }, internalConflict: { type: 'string' },
    beliefs: { type: 'array', maxItems: 5, items: { type: 'string' } }, commitments: { type: 'array', maxItems: 5, items: { type: 'string' } },
    developmentNotes: { type: 'array', maxItems: 6, items: { type: 'string' } }, lastChangedSequence: { type: 'integer', minimum: 0 }
  }, required: ['currentGoal','internalConflict','beliefs','commitments','developmentNotes','lastChangedSequence'], additionalProperties: false
};

const storyStateSchema = {
  type: 'object', properties: {
    version: { type: 'integer' }, arcPhase: { type: 'string', enum: ['setup','rising','turning','climax','aftermath'] }, tension: { type: 'integer', minimum: 0, maximum: 100 }, pacing: { type: 'string', enum: ['slow','steady','fast'] },
    activeTensions: { type: 'array', maxItems: 5, items: { type: 'object', properties: { id: { type: 'string' }, summary: { type: 'string' }, involvedCharacterIds: { type: 'array', maxItems: 6, items: { type: 'string' } }, pressure: { type: 'integer', minimum: 0, maximum: 100 }, introducedAtSequence: { type: 'integer', minimum: 0 } }, required: ['id','summary','involvedCharacterIds','pressure','introducedAtSequence'], additionalProperties: false } },
    openQuestions: { type: 'array', maxItems: 5, items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, involvedCharacterIds: { type: 'array', maxItems: 6, items: { type: 'string' } }, urgency: { type: 'integer', minimum: 0, maximum: 100 }, introducedAtSequence: { type: 'integer', minimum: 0 } }, required: ['id','text','involvedCharacterIds','urgency','introducedAtSequence'], additionalProperties: false } },
    recentBeats: { type: 'array', maxItems: 8, items: { type: 'object', properties: { sequence: { type: 'integer', minimum: 0 }, type: { type: 'string', enum: ['connection','conflict','choice','setback','reveal','discovery','transition','reflection'] }, summary: { type: 'string' } }, required: ['sequence','type','summary'], additionalProperties: false } },
    lastDirectorSequence: { type: 'integer', minimum: 0 }
  }, required: ['version','arcPhase','tension','pacing','activeTensions','openQuestions','recentBeats','lastDirectorSequence'], additionalProperties: false
};

const dramaticStateSchema = {
  type: 'object', properties: { objective: { type: 'string' }, stakes: { type: 'string' }, dilemma: { type: 'string' }, beatType: { type: 'string', enum: ['connection','conflict','choice','setback','reveal','discovery','transition','reflection'] }, targetTension: { type: 'integer', minimum: 0, maximum: 100 }, participantIds: { type: 'array', maxItems: 6, items: { type: 'string' } } },
  required: ['objective','stakes','dilemma','beatType','targetTension','participantIds'], additionalProperties: false
};

const eventPlanProperties = { text: { type: 'string' }, eventType: { type: 'string', enum: ['일상','관계','연락','선택','발견','돌발','시간 전환','분위기','일반'] }, time: { type: 'string' }, location: { type: 'string' }, mood: { type: 'string' }, description: { type: 'string' } };
const beatPlanSchema = {
  type: 'object', properties: {
    phase: { type: 'string', enum: ['build','pressure','choice','consequence','release'] },
    outcome: { type: 'string', enum: ['open','success','qualified_success','setback'] },
    tensionDirection: { type: 'string', enum: ['rise','hold','fall'] },
    conditionOrCost: { type: 'string' }, reliefReason: { type: 'string' }
  }, required: ['phase','outcome','tensionDirection','conditionOrCost','reliefReason'], additionalProperties: false
};
const storyPatchSchema = {
  type: 'object', properties: {
    arcPhase: { type: ['string','null'], enum: ['setup','rising','turning','climax','aftermath',null] },
    tension: { type: ['integer','null'], minimum: 0, maximum: 100 },
    pacing: { type: ['string','null'], enum: ['slow','steady','fast',null] },
    upsertActiveTensions: { type: 'array', maxItems: 3, items: { type: 'object', properties: { id: { type: 'string' }, summary: { type: 'string' }, involvedCharacterIds: { type: 'array', maxItems: 6, items: { type: 'string' } }, pressure: { type: 'integer', minimum: 0, maximum: 100 }, introducedAtSequence: { type: 'integer', minimum: 0 } }, required: ['id','summary','involvedCharacterIds','pressure','introducedAtSequence'], additionalProperties: false } },
    removeActiveTensionIds: { type: 'array', maxItems: 5, items: { type: 'string' } },
    upsertOpenQuestions: { type: 'array', maxItems: 3, items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, involvedCharacterIds: { type: 'array', maxItems: 6, items: { type: 'string' } }, urgency: { type: 'integer', minimum: 0, maximum: 100 }, introducedAtSequence: { type: 'integer', minimum: 0 } }, required: ['id','text','involvedCharacterIds','urgency','introducedAtSequence'], additionalProperties: false } },
    removeOpenQuestionIds: { type: 'array', maxItems: 5, items: { type: 'string' } },
    recentBeat: { type: 'object', properties: { type: { type: 'string', enum: ['connection','conflict','choice','setback','reveal','discovery','transition','reflection'] }, summary: { type: 'string' } }, required: ['type','summary'], additionalProperties: false }
  }, required: ['arcPhase','tension','pacing','upsertActiveTensions','removeActiveTensionIds','upsertOpenQuestions','removeOpenQuestionIds','recentBeat'], additionalProperties: false
};
const directorProgressionSchema = {
  type: 'object', properties: {
    action: { type: 'string', enum: ['CONTINUE','INJECT_MINOR_EVENT','TRANSITION_SCENE','PROPOSE_MAJOR'] }, rationale: { type: 'string' },
    responders: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'object', properties: { characterId: { type: 'string' }, reason: { type: 'string' } }, required: ['characterId','reason'], additionalProperties: false } },
    storyPatch: storyPatchSchema, sceneState: dramaticStateSchema, beatPlan: beatPlanSchema,
    eventPlan: { type: 'object', properties: eventPlanProperties, required: Object.keys(eventPlanProperties), additionalProperties: false },
    nextScene: { type: 'object', properties: { ...eventPlanProperties, participantIds: { type: 'array', maxItems: 6, items: { type: 'string' } } }, required: [...Object.keys(eventPlanProperties),'participantIds'], additionalProperties: false },
    majorProposals: { type: 'array', maxItems: 3, items: { type: 'object', properties: { category: { type: 'string', enum: ['관계','선택','발견','돌발','시간 전환','분위기'] }, text: { type: 'string' }, consequence: { type: 'string' }, time: { type: 'string' } }, required: ['category','text','consequence','time'], additionalProperties: false } }
  }, required: ['action','rationale','responders','storyPatch','sceneState','beatPlan','eventPlan','nextScene','majorProposals'], additionalProperties: false
};

const storyRepairSchema = {
  type: 'object', properties: {
    summary: { type: 'string' }, storyState: storyStateSchema, sceneState: dramaticStateSchema,
    participantIds: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string' } },
    characterStates: { type: 'array', items: { type: 'object', properties: { characterId: { type: 'string' }, state: characterStateSchema }, required: ['characterId','state'], additionalProperties: false } },
    relationships: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' }, score: { type: 'integer', minimum: 0, maximum: 100 } }, required: ['from','to','label','score'], additionalProperties: false } },
    memoryDecisions: { type: 'array', items: { type: 'object', properties: { memoryId: { type: 'string' }, action: { type: 'string', enum: ['KEEP','ARCHIVE'] } }, required: ['memoryId','action'], additionalProperties: false } }
  }, required: ['summary','storyState','sceneState','participantIds','characterStates','relationships','memoryDecisions'], additionalProperties: false
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

const worldDraftSchema = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    missingItems: { type: 'array', maxItems: 6, items: { type: 'string' } },
    draft: {
      type: 'object',
      properties: {
        world: {
          type: 'object', properties: {
            title: { type: 'string' }, location: { type: 'string' }, mood: { type: 'string' }, time: { type: 'string' },
            description: { type: 'string' }, rules: { type: 'string' }, presentationMode: { type: 'string', enum: ['scene', 'chat'] }, dramaIntensity: { type: 'string', enum: ['gentle','balanced','high'] }
          }, required: ['title','location','mood','time','description','rules','presentationMode','dramaIntensity'], additionalProperties: false
        },
        story: {
          type: 'object', properties: {
            premise: { type: 'string' }, openingQuestion: { type: 'string' },
            coreTensions: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object', properties: { summary: { type: 'string' }, involvedCharacterKeys: { type: 'array', maxItems: 6, items: { type: 'string' } }, pressure: { type: 'integer', minimum: 0, maximum: 100 } }, required: ['summary','involvedCharacterKeys','pressure'], additionalProperties: false } }
          }, required: ['premise','openingQuestion','coreTensions'], additionalProperties: false
        },
        characters: {
          type: 'array', minItems: 2, maxItems: 6, items: {
            type: 'object', properties: {
              key: { type: 'string' }, name: { type: 'string' }, gender: { type: 'string', enum: ['여성','남성','논바이너리','성별 없음'] },
              role: { type: 'string' }, emoji: { type: 'string' }, color: { type: 'string' }, personality: { type: 'string' },
              speechStyle: { type: 'string' }, goal: { type: 'string' }, secret: { type: 'string' }, emotion: { type: 'string' }
            }, required: ['key','name','gender','role','emoji','color','personality','speechStyle','goal','secret','emotion'], additionalProperties: false
          }
        },
        relationships: {
          type: 'array', maxItems: 15, items: {
            type: 'object', properties: {
              characterKeys: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string' } },
              label: { type: 'string' }, score: { type: 'integer', minimum: 0, maximum: 100 }
            }, required: ['characterKeys','label','score'], additionalProperties: false
          }
        }
      }, required: ['world','story','characters','relationships'], additionalProperties: false
    }
  }, required: ['reply','missingItems','draft'], additionalProperties: false
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
    this.threadUsage = new Map();
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
    await this.request('initialize', { clientInfo: { name: 'sceneweaver', version: '0.1.0' }, capabilities: {} });
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
      } else if (message.method === 'thread/tokenUsage/updated') {
        if (message.params?.threadId && message.params?.tokenUsage) this.threadUsage.set(message.params.threadId, message.params.tokenUsage);
      } else if (message.method === 'item/agentMessage/delta' && this.activeTurn && !this.activeTurn.firstTokenAt) {
        this.activeTurn.firstTokenAt = Date.now();
      } else if (message.method === 'turn/completed' && this.activeTurn) {
        const activeTurn = this.activeTurn;
        this.activeTurn = null;
        activeTurn.resolve({ turn: message.params?.turn, timeToFirstTokenMs: activeTurn.firstTokenAt ? activeTurn.firstTokenAt - activeTurn.startedAt : null });
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
      const started = await this.request('thread/start', { model, cwd: AGENT_CWD, approvalPolicy: 'never', sandbox: 'read-only', serviceName: 'sceneweaver' });
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

  async runTurn(prompt, outputSchema, runId, { threadId: existingThreadId = null, model = CODEX_MODEL, effort = 'medium', persistent = false, usage = 'Codex 호출', rollover = false } = {}) {
    const ensured = await this.ensureThread(existingThreadId, model, effort, runId, usage);
    const threadId = ensured.threadId;
    if (!threadId) throw new Error('Codex app-server did not return a thread id.');
    const modelStage = startStage(runId, 'model_generate', { threadId, model, effort, usage });
    const completion = new Promise((resolve, reject) => { this.activeTurn = { resolve, reject, threadId, startedAt: Date.now(), firstTokenAt: null }; });
    try {
      await this.request('turn/start', { threadId, model, effort, cwd: AGENT_CWD, approvalPolicy: 'never', sandbox: 'read-only', input: [{ type: 'text', text: prompt }], outputSchema });
      const completed = await completion;
      const tokenUsage = this.threadUsage.get(threadId) || null;
      const last = tokenUsage?.last || null;
      endStage(runId, modelStage, { outputItems: completed.turn?.items?.length || 0, usage, rollover, timeToFirstTokenMs: completed.timeToFirstTokenMs, inputTokens: last?.inputTokens, cachedInputTokens: last?.cachedInputTokens, outputTokens: last?.outputTokens, reasoningOutputTokens: last?.reasoningOutputTokens, contextTokens: last?.inputTokens });
      return { turn: completed.turn, threadId, reused: ensured.reused, tokenUsage, timeToFirstTokenMs: completed.timeToFirstTokenMs };
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
    this.loadedThreads.delete(threadId);
    this.threadUsage.delete(threadId);
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

export async function cleanupCodexThread(threadId) {
  if (!threadId || !appServer || appServer.closed) return;
  await appServer.cleanupThread(threadId);
}

async function executeStructured({ prompt, outputSchema, validate, label, runId, thread, timeoutMs = TIMEOUT_MS }) {
  const appServerStage = startStage(runId, 'app_server_ready');
  const { client, reused } = getAppServer();
  let timer;
  try {
    await client.ready;
    endStage(runId, appServerStage, { reused, pid: client.child.pid });
    const turn = await Promise.race([
      client.runTurn(prompt, outputSchema, runId, { ...thread, usage: label }),
      new Promise((_, reject) => { timer = setTimeout(() => { const error = new Error(`Codex ${label} timed out after ${timeoutMs / 1000} seconds.`); client.destroy(error); reject(error); }, timeoutMs); })
    ]);
    if (turn?.turn?.status !== 'completed') throw new Error(`Codex ${label} failed: ${turn?.turn?.error?.message || turn?.turn?.status || 'unknown error'}`);
    const validationStage = startStage(runId, 'output_validate');
    const text = turn.turn.items?.find((item) => item.type === 'agentMessage')?.text;
    try {
      const result = JSON.parse(text);
      validate(result);
      endStage(runId, validationStage, { responseChars: text?.length || 0 });
      return { ...result, threadId: turn.threadId, threadReused: turn.reused, threadUsage: turn.tokenUsage, timeToFirstTokenMs: turn.timeToFirstTokenMs, threadRolledOver: Boolean(thread.rollover), previousThreadId: thread.previousThreadId || null };
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
  const rollover = shouldRollover('character', context.character.activeThreadId, context.character.activeThreadTurnCount, context.character.activeThreadContextTokens, context.character.threadRolloverRequired);
  return runCodexStructured({
    prompt, outputSchema: turnSchema, label: `캐릭터 응답 · ${context.character.name}`, runId: context.runId,
    thread: { threadId: rollover ? null : context.character.activeThreadId, previousThreadId: rollover ? context.character.activeThreadId : null, rollover, model: context.character.effectiveModel || CODEX_MODEL, effort: context.character.effectiveReasoningEffort || 'medium', persistent: true },
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
      if (!BEAT_OUTCOMES.has(result.beatOutcome) || typeof result.conditionOrCost !== 'string') throw new Error('invalid beat outcome');
      result.conditionOrCost = result.conditionOrCost.trim().slice(0, 240);
      const expectedOutcome = context.state.dramaticState?.outcomeConstraint || 'open';
      if (result.shouldRespond && result.beatOutcome !== expectedOutcome) throw new Error(`beat outcome must be ${expectedOutcome}`);
      if (result.shouldRespond && ['qualified_success','setback'].includes(result.beatOutcome) && !result.conditionOrCost) throw new Error('qualified success or setback requires a concrete condition or cost');
      const patch = result.statePatch;
      if (!patch || typeof patch !== 'object' || !['setCurrentGoal','setInternalConflict'].every((key) => patch[key] === null || typeof patch[key] === 'string')) throw new Error('invalid character state patch');
      for (const key of ['addBeliefs','removeBeliefs','addCommitments','removeCommitments','appendDevelopmentNotes']) if (!Array.isArray(patch[key]) || patch[key].some((item) => typeof item !== 'string')) throw new Error(`invalid character state patch ${key}`);
      result.nextState = applyCharacterStatePatch(context.character.currentState, patch, context.character.goal);
      for (const change of result.relationshipChanges) {
        if (typeof change.label !== 'string' || typeof change.reason !== 'string') throw new Error('invalid relationship change');
        change.label = change.label.trim().slice(0, 120); change.reason = change.reason.trim().slice(0, 240);
      }
      if (!['continue', 'stalled', 'complete'].includes(result.sceneSignal)) throw new Error('invalid sceneSignal');
      if (!result.shouldRespond && (result.memory || result.memoryImportance !== 0 || result.relationshipChanges.length || result.beatOutcome !== 'open' || result.conditionOrCost || result.sceneSignal !== 'continue' || JSON.stringify(result.nextState) !== JSON.stringify(cleanCharacterState(context.character.currentState, context.character.goal)))) throw new Error('silent response contains state changes');
    }
  });
}

export function generateDirectorProgressionPlan(state, participants, runId, director) {
  updateRunMetadata(runId, { activeAgentType: 'director', activeAgentName: '월드 디렉터', activePhase: '진행 계획', activeThreadId: director.activeThreadId || null, activeModel: director.model || CODEX_MODEL, activeEffort: director.reasoningEffort || 'high' });
  const prompt = buildDirectorProgressionPrompt(state, participants);
  return runCodexStructured({ prompt, outputSchema: directorProgressionSchema, label: 'World Director · 진행 계획', runId,
    thread: directorThreadOptions(director),
    validate: (result) => {
      if (!DIRECTOR_ACTIONS.has(result.action) || typeof result.rationale !== 'string') throw new Error('invalid Director action');
      const characterIds = state.characters.map((item) => item.id);
      if (!result.storyPatch || typeof result.storyPatch !== 'object') throw new Error('invalid story state patch');
      result.storyState = applyStoryStatePatch(state.storyState, result.storyPatch, characterIds, state.latestSceneSequence);
      const beatPlan = result.beatPlan;
      if (!RHYTHM_PHASES.has(beatPlan?.phase) || !BEAT_OUTCOMES.has(beatPlan?.outcome) || !TENSION_DIRECTIONS.has(beatPlan?.tensionDirection)) throw new Error('invalid beat plan');
      beatPlan.conditionOrCost = String(beatPlan.conditionOrCost || '').trim().slice(0, 240);
      beatPlan.reliefReason = String(beatPlan.reliefReason || '').trim().slice(0, 240);
      if (['qualified_success','setback'].includes(beatPlan.outcome) && !beatPlan.conditionOrCost) throw new Error('Director beat requires a condition or cost');
      if (beatPlan.phase === 'release' && beatPlan.outcome === 'success' && !beatPlan.reliefReason) throw new Error('release beat requires a relief reason');
      const actualDirection = tensionDirection(state.storyState.tension, result.storyState.tension);
      if (actualDirection !== beatPlan.tensionDirection) throw new Error(`tension direction must match numeric change (${actualDirection})`);
      const previousRhythm = cleanRhythmState(state.storyState.rhythm, state.storyState.recentBeats);
      if (previousRhythm.consecutiveRises >= 2 && actualDirection === 'rise' && result.storyState.arcPhase !== 'climax') throw new Error('tension cannot rise three times outside climax');
      if (previousRhythm.repeatedOutcomeCount >= 2 && previousRhythm.lastOutcome === beatPlan.outcome && previousRhythm.phase === beatPlan.phase) throw new Error('Director repeated the same narrative function and outcome');
      result.storyState.rhythm = advanceRhythmState(state.storyState, beatPlan, result.storyState.tension);
      result.sceneState = cleanDramaticState({ ...result.sceneState, beatIntent: beatPlan.phase, outcomeConstraint: beatPlan.outcome, pressureSource: beatPlan.conditionOrCost, reliefReason: beatPlan.reliefReason }, characterIds, state.dramaticState);
      if (!Array.isArray(result.responders) || result.responders.length < 1 || result.responders.length > 2) throw new Error('invalid responders');
      if (result.action === 'INJECT_MINOR_EVENT' && (!result.eventPlan?.text?.trim() || !result.eventPlan?.eventType?.trim())) throw new Error('minor event plan is required');
      if (result.action === 'TRANSITION_SCENE' && (!result.nextScene?.description?.trim() || !result.nextScene?.participantIds?.length)) throw new Error('next scene plan is required');
      if (result.action === 'PROPOSE_MAJOR' && (!Array.isArray(result.majorProposals) || result.majorProposals.length < 2 || result.majorProposals.length > 3)) throw new Error('major proposals require 2-3 options');
    }
  });
}

export function generateStoryRepair(context, runId, director) {
  updateRunMetadata(runId, { activeAgentType: 'director', activeAgentName: '월드 디렉터', activePhase: '이야기 상태 진단', activeThreadId: director.activeThreadId || null, activeModel: director.model || CODEX_MODEL, activeEffort: director.reasoningEffort || 'high' });
  return runCodexStructured({ prompt: buildStoryRepairPrompt(context), outputSchema: storyRepairSchema, label: 'World Director · 이야기 보정안', runId, timeoutMs: 240000,
    thread: directorThreadOptions(director),
    validate: (result) => {
      const ids = context.state.characters.map((item) => item.id);
      result.storyState = cleanStoryState(result.storyState, ids, context.state.storyState);
      result.sceneState = cleanDramaticState(result.sceneState, ids, context.state.dramaticState);
      if (typeof result.summary !== 'string' || !result.summary.trim()) throw new Error('repair summary is required');
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
    thread: directorThreadOptions(director),
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
    thread: directorThreadOptions(director),
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
    thread: directorThreadOptions(director),
    validate: (result) => validateDirectorEventPlan(result, { requireScene: event.forceScene })
  });
}

export function generateDirectorSceneTransition(state, runId, director) {
  updateRunMetadata(runId, { activeAgentType: 'director', activeAgentName: '월드 디렉터', activePhase: '장면 전환 판단', activeThreadId: director.activeThreadId || null, activeModel: director.model || CODEX_MODEL, activeEffort: director.reasoningEffort || 'high' });
  const prompt = buildDirectorSceneTransitionPrompt(state);
  return runCodexStructured({ prompt, outputSchema: directorEventPlanSchema, label: 'World Director · 장면 전환', runId,
    thread: directorThreadOptions(director),
    validate: (result) => validateDirectorEventPlan(result, { requireScene: true })
  });
}

export function generateWorldDraft(context) {
  updateRunMetadata(context.runId, { activeAgentType: 'world_builder', activeAgentName: '월드 설계자', activePhase: '월드 초안 설계', activeThreadId: context.threadId || null, activeModel: context.model || CODEX_MODEL, activeEffort: context.reasoningEffort || 'medium' });
  const stage = startStage(context.runId, 'context_build');
  const prompt = buildWorldDraftPrompt(context);
  endStage(context.runId, stage, { promptChars: prompt.length, messages: context.messages.length, characters: context.draft.characters?.length || 0 });
  return runCodexStructured({
    prompt, outputSchema: worldDraftSchema, label: '월드 설계자 · 초안 갱신', runId: context.runId,
    thread: { threadId: context.threadId, model: context.model || CODEX_MODEL, effort: context.reasoningEffort || 'medium', persistent: true },
    validate: (result) => {
      if (typeof result.reply !== 'string' || !result.reply.trim()) throw new Error('missing world builder reply');
      result.reply = result.reply.trim();
      if (result.reply.length > 1000) throw new Error('world builder reply is too long');
      if (!Array.isArray(result.missingItems) || !result.draft || typeof result.draft !== 'object') throw new Error('invalid world draft');
    }
  });
}
