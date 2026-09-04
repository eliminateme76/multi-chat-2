import { randomUUID } from 'node:crypto';

const MAX_RUNS = 200;
const runs = [];
const listeners = new Set();
const resources = { appServer: { status: 'idle', pid: null, startedAt: null } };
let persistCompletedRun = null;

const now = () => new Date().toISOString();
const duration = (start, end = Date.now()) => Math.max(0, end - start);
const publish = (type, payload) => {
  const event = JSON.stringify({ type, payload, timestamp: now() });
  for (const listener of listeners) listener(event);
};
const findRun = (runId) => runs.find((run) => run.id === runId);
const persist = (run) => {
  if (!persistCompletedRun || !run) return;
  Promise.resolve(persistCompletedRun(publicRun(run))).catch((error) => console.error(`Runtime trace persistence failed: ${error.message}`));
};

export function configureRuntimePersistence(handler) {
  persistCompletedRun = typeof handler === 'function' ? handler : null;
}

export function startRun({ type, projectId, metadata = {} }) {
  const run = { id: randomUUID(), type, projectId, status: 'running', startedAt: now(), startedMs: Date.now(), endedAt: null, durationMs: null, metadata, stages: [] };
  runs.unshift(run);
  if (runs.length > MAX_RUNS) runs.length = MAX_RUNS;
  publish('run', publicRun(run));
  return run.id;
}

export function startStage(runId, name, metadata = {}) {
  const run = findRun(runId);
  if (!run) return null;
  const stage = { id: randomUUID(), name, status: 'running', startedAt: now(), startedMs: Date.now(), endedAt: null, durationMs: null, metadata };
  run.stages.push(stage);
  publish('run', publicRun(run));
  return stage.id;
}

export function endStage(runId, stageId, metadata = {}) {
  const run = findRun(runId); const stage = run?.stages.find((item) => item.id === stageId);
  if (!stage) return;
  stage.status = 'completed'; stage.endedAt = now(); stage.durationMs = duration(stage.startedMs); stage.metadata = { ...stage.metadata, ...metadata };
  publish('run', publicRun(run));
}

export function failStage(runId, stageId, error) {
  const run = findRun(runId); const stage = run?.stages.find((item) => item.id === stageId);
  if (!stage || stage.status !== 'running') return;
  stage.status = 'failed'; stage.endedAt = now(); stage.durationMs = duration(stage.startedMs); stage.metadata = { ...stage.metadata, error: error.message };
  publish('run', publicRun(run));
}

export function recordStage(runId, name, durationMs, metadata = {}) {
  const run = findRun(runId);
  if (!run) return;
  const endedMs = Date.now();
  run.stages.push({ id: randomUUID(), name, status: 'completed', startedAt: new Date(endedMs - durationMs).toISOString(), startedMs: endedMs - durationMs, endedAt: new Date(endedMs).toISOString(), durationMs, metadata });
  publish('run', publicRun(run));
}

export function finishRun(runId, metadata = {}) {
  const run = findRun(runId);
  if (!run) return;
  run.status = 'completed'; run.endedAt = now(); run.durationMs = duration(run.startedMs); run.metadata = { ...run.metadata, ...metadata };
  publish('run', publicRun(run));
  persist(run);
}

export function updateRunMetadata(runId, metadata = {}) {
  const run = findRun(runId);
  if (!run) return;
  run.metadata = { ...run.metadata, ...metadata };
  publish('run', publicRun(run));
}

export function failRun(runId, error) {
  const run = findRun(runId);
  if (!run) return;
  run.status = 'failed'; run.endedAt = now(); run.durationMs = duration(run.startedMs); run.metadata = { ...run.metadata, error: error.message };
  publish('run', publicRun(run));
  persist(run);
}

export function setRuntimeResource(name, value) {
  resources[name] = { ...(resources[name] || {}), ...value };
  publish('resource', { name, value: resources[name] });
}

export function snapshot() {
  return { resources: structuredClone(resources), runs: runs.map(publicRun) };
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publicRun(run) {
  const { startedMs, ...safeRun } = run;
  return { ...safeRun, stages: run.stages.map(({ startedMs: _startedMs, ...stage }) => ({ ...stage })) };
}
