import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCharacterTurnPrompt, buildDirectorProgressionPrompt } from './context-builder.js';
import { generateCodexTurn, generateDirectorProgressionPlan } from './codex-client.js';
import { recordStage, setRuntimeResource, updateRunMetadata } from './runtime-telemetry.js';

const ENGINE = Object.freeze({ name: 'concordia', version: '2.4.0' });
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.CONCORDIA_PYTHON?.trim() || path.join(ROOT, '.venv', 'bin', 'python');
const TIMEOUT_MS = Number(process.env.CONCORDIA_WORKER_TIMEOUT_MS || 180000);

let worker;
let workerQueue = Promise.resolve();

const runtimeFields = (value) => ({
  threadId: value.threadId,
  threadReused: value.threadReused,
  threadUsage: value.threadUsage,
  timeToFirstTokenMs: value.timeToFirstTokenMs,
  threadRolledOver: value.threadRolledOver,
  previousThreadId: value.previousThreadId
});

class ConcordiaWorker {
  constructor() {
    this.child = spawn(PYTHON, ['-m', 'concordia_runtime.worker'], {
      cwd: ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.buffer = '';
    this.stderr = '';
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    setRuntimeResource('concordiaWorker', { status: 'starting', pid: this.child.pid, engine: ENGINE.name, version: ENGINE.version, startedAt: new Date().toISOString() });
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.on('data', (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-4000); });
    this.child.on('error', (error) => this.destroy(new Error(`Concordia worker를 시작할 수 없습니다: ${error.message}`)));
    this.child.on('exit', (code, signal) => {
      if (!this.closed) this.destroy(new Error(`Concordia worker가 예기치 않게 종료되었습니다 (${signal || code}). ${this.stderr}`.trim()));
    });
    this.ready = this.request('health', {}).then((health) => {
      if (health?.version !== ENGINE.version) throw new Error(`Concordia worker 버전 불일치: ${health?.version || 'unknown'}`);
      setRuntimeResource('concordiaWorker', { status: 'ready', pid: this.child.pid, engine: health.engine, version: health.version });
      return health;
    });
  }

  send(message) {
    if (this.closed || !this.child.stdin.writable) throw new Error('Concordia worker를 사용할 수 없습니다.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, modelCallback = null) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, modelCallback });
      try { this.send({ id, method, params }); } catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method === 'model/sample') {
        const active = [...this.pending.values()].find((item) => item.modelCallback);
        if (!active) { this.send({ id: message.id, error: { message: '활성 모델 콜백이 없습니다.' } }); continue; }
        Promise.resolve(active.modelCallback(message.params || {}))
          .then((result) => this.send({ id: message.id, result }))
          .catch((error) => this.send({ id: message.id, error: { message: error.message } }));
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`Concordia worker: ${message.error.message || 'unknown error'}`));
      else pending.resolve(message.result);
    }
  }

  destroy(error = new Error('Concordia worker가 중지되었습니다.')) {
    if (this.closed) return;
    this.closed = true;
    if (worker === this) worker = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (!this.child.killed) this.child.kill();
    setRuntimeResource('concordiaWorker', { status: 'stopped', pid: null, stoppedAt: new Date().toISOString(), error: error.message });
  }
}

function getWorker() {
  if (!worker || worker.closed) worker = new ConcordiaWorker();
  return worker;
}

function invokeWorker(method, params, modelCallback, runId, stageName) {
  const queued = workerQueue.then(async () => {
    const startedAt = Date.now();
    let modelCallbackMs = 0;
    const measuredModelCallback = async (callbackParams) => {
      const callbackStartedAt = Date.now();
      try { return await modelCallback(callbackParams); }
      finally { modelCallbackMs += Date.now() - callbackStartedAt; }
    };
    const client = getWorker();
    await client.ready;
    let timer;
    try {
      const result = await Promise.race([
        client.request(method, params, measuredModelCallback),
        new Promise((_, reject) => { timer = setTimeout(() => { const error = new Error(`Concordia ${method} timed out.`); client.destroy(error); reject(error); }, TIMEOUT_MS); })
      ]);
      const totalDurationMs = Date.now() - startedAt;
      recordStage(runId, stageName, Math.max(0, totalDurationMs - modelCallbackMs), { engine: result.engine?.name, version: result.engine?.version, entity: result.concordia?.entity, components: result.concordia?.components, totalDurationMs, modelCallbackMs });
      return result;
    } finally { clearTimeout(timer); }
  });
  workerQueue = queued.catch(() => {});
  return queued;
}

export async function generateConcordiaTurn(context) {
  const modelPrompt = buildCharacterTurnPrompt(context);
  updateRunMetadata(context.runId, { simulationEngine: ENGINE.name, simulationEngineVersion: ENGINE.version, activePhase: 'Concordia 캐릭터 판단' });
  const result = await invokeWorker('entity/act', {
    name: context.character.name,
    premise: `월드 ${context.state.world.title} · 장면 ${context.state.sceneNumber}`,
    components: {
      'authoritative DB context': modelPrompt
    },
    modelRequest: { kind: 'character' }
  }, async ({ prompt }) => {
    const value = await generateCodexTurn(context, prompt);
    return { value, runtime: runtimeFields(value) };
  }, context.runId, 'concordia_entity');
  return { ...result.value, engine: result.engine, concordia: result.concordia };
}

export async function generateConcordiaDirectorPlan(state, participants, runId, director, correction = '') {
  const modelPrompt = buildDirectorProgressionPrompt(state, participants, correction);
  updateRunMetadata(runId, { simulationEngine: ENGINE.name, simulationEngineVersion: ENGINE.version, activePhase: 'Concordia 월드 판정' });
  const result = await invokeWorker('gm/judge', {
    components: {
      'authoritative DB world state': modelPrompt
    },
    observations: [],
    modelRequest: { kind: 'game_master' }
  }, async ({ prompt }) => {
    const value = await generateDirectorProgressionPlan(state, participants, runId, director, correction, prompt);
    return { value, runtime: runtimeFields(value) };
  }, runId, 'concordia_game_master');
  return { ...result.value, engine: result.engine, concordia: result.concordia };
}

export function concordiaEngineInfo() { return { ...ENGINE }; }

process.once('exit', () => worker?.destroy());
