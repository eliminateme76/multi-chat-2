import { createHash, randomUUID } from 'node:crypto';

export const DRAMA_INTENSITIES = new Set(['gentle', 'balanced', 'high']);
export const BEAT_TYPES = new Set(['connection', 'conflict', 'choice', 'setback', 'reveal', 'discovery', 'transition', 'reflection']);
export const DIRECTOR_ACTIONS = new Set(['CONTINUE', 'INJECT_MINOR_EVENT', 'TRANSITION_SCENE', 'PROPOSE_MAJOR']);
export const RHYTHM_PHASES = new Set(['build', 'pressure', 'choice', 'consequence', 'release']);
export const BEAT_OUTCOMES = new Set(['open', 'success', 'qualified_success', 'setback']);
export const TENSION_DIRECTIONS = new Set(['rise', 'hold', 'fall']);

const clean = (value, max, fallback = '') => typeof value === 'string' ? value.trim().slice(0, max) : fallback;
const strings = (value, maxItems, maxLength) => Array.isArray(value) ? value.map((item) => clean(item, maxLength)).filter(Boolean).slice(0, maxItems) : [];
const integer = (value, min, max, fallback) => Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
const validId = (value, allowed) => typeof value === 'string' && allowed.has(value);

export function emptyStoryState() {
  return { version: 1, arcPhase: 'setup', tension: 35, pacing: 'steady', activeTensions: [], openQuestions: [], recentBeats: [], rhythm: emptyRhythmState(), lastDirectorSequence: 0 };
}

export function emptyDramaticState() {
  return { objective: '', stakes: '', dilemma: '', beatType: 'reflection', targetTension: 35, participantIds: [], beatIntent: 'build', outcomeConstraint: 'open', pressureSource: '', reliefReason: '', plannedResponderIds: [], planResponderIds: [], planStartedSequence: 0, responsesConsumed: 0, planAction: '', planRationale: '', planOperationId: '' };
}

export function emptyRhythmState() {
  return { phase: 'build', lastOutcome: 'open', repeatedOutcomeCount: 0, consecutiveRises: 0, lastTensionDirection: 'hold' };
}

function inferredBeat(type) {
  if (type === 'connection' || type === 'reflection') return { phase: 'release', outcome: 'success' };
  if (type === 'conflict' || type === 'setback') return { phase: 'pressure', outcome: 'setback' };
  if (type === 'choice') return { phase: 'choice', outcome: 'open' };
  if (type === 'transition') return { phase: 'build', outcome: 'success' };
  return { phase: 'build', outcome: 'open' };
}

export function cleanRhythmState(value, recentBeats = []) {
  const source = value && typeof value === 'object' ? value : {};
  const inferred = inferredBeat(recentBeats.at(-1)?.type);
  const lastOutcome = BEAT_OUTCOMES.has(source.lastOutcome) ? source.lastOutcome : inferred.outcome;
  let repeatedOutcomeCount = integer(source.repeatedOutcomeCount, 0, 8, 0);
  if (!repeatedOutcomeCount && recentBeats.length) {
    for (let index = recentBeats.length - 1; index >= 0 && inferredBeat(recentBeats[index].type).outcome === lastOutcome; index -= 1) repeatedOutcomeCount += 1;
  }
  return {
    phase: RHYTHM_PHASES.has(source.phase) ? source.phase : inferred.phase,
    lastOutcome, repeatedOutcomeCount,
    consecutiveRises: integer(source.consecutiveRises, 0, 8, 0),
    lastTensionDirection: TENSION_DIRECTIONS.has(source.lastTensionDirection) ? source.lastTensionDirection : 'hold'
  };
}

export function tensionDirection(before, after) {
  const delta = Number(after) - Number(before);
  return delta > 2 ? 'rise' : delta < -2 ? 'fall' : 'hold';
}

export function advanceRhythmState(previousState, beatPlan, nextTension) {
  const previous = cleanRhythmState(previousState?.rhythm, previousState?.recentBeats);
  const direction = tensionDirection(previousState?.tension ?? nextTension, nextTension);
  const outcome = BEAT_OUTCOMES.has(beatPlan?.outcome) ? beatPlan.outcome : 'open';
  return {
    phase: RHYTHM_PHASES.has(beatPlan?.phase) ? beatPlan.phase : 'build',
    lastOutcome: outcome,
    repeatedOutcomeCount: previous.lastOutcome === outcome ? Math.min(8, previous.repeatedOutcomeCount + 1) : 1,
    consecutiveRises: direction === 'rise' ? Math.min(8, previous.consecutiveRises + 1) : 0,
    lastTensionDirection: direction
  };
}

export function cleanCharacterState(value = {}, fallbackGoal = '') {
  return {
    currentGoal: clean(value.currentGoal, 180, fallbackGoal),
    internalConflict: clean(value.internalConflict, 220),
    beliefs: strings(value.beliefs, 5, 160),
    commitments: strings(value.commitments, 5, 160),
    developmentNotes: strings(value.developmentNotes, 6, 180),
    lastChangedSequence: Math.max(0, Number(value.lastChangedSequence) || 0)
  };
}

function mergeStringList(current, additions, removals, maxItems, maxLength) {
  const removed = new Set(strings(removals, maxItems * 2, maxLength));
  return [...new Set([...strings(current, maxItems, maxLength).filter((item) => !removed.has(item)), ...strings(additions, maxItems, maxLength)])].slice(-maxItems);
}

export function applyCharacterStatePatch(current, patch = {}, fallbackGoal = '') {
  const base = cleanCharacterState(current, fallbackGoal);
  return cleanCharacterState({
    currentGoal: patch.setCurrentGoal === null || patch.setCurrentGoal === undefined ? base.currentGoal : patch.setCurrentGoal,
    internalConflict: patch.setInternalConflict === null || patch.setInternalConflict === undefined ? base.internalConflict : patch.setInternalConflict,
    beliefs: mergeStringList(base.beliefs, patch.addBeliefs, patch.removeBeliefs, 5, 160),
    commitments: mergeStringList(base.commitments, patch.addCommitments, patch.removeCommitments, 5, 160),
    developmentNotes: mergeStringList(base.developmentNotes, patch.appendDevelopmentNotes, [], 6, 180),
    lastChangedSequence: base.lastChangedSequence
  }, fallbackGoal);
}

export function applyStoryStatePatch(current, patch = {}, characterIds = [], beatSequence = 0) {
  const base = cleanStoryState(current, characterIds);
  const removedTensions = new Set(strings(patch.removeActiveTensionIds, 10, 64));
  const removedQuestions = new Set(strings(patch.removeOpenQuestionIds, 10, 64));
  const upsert = (items, updates, removed, textField) => {
    const byId = new Map(items.filter((item) => !removed.has(item.id)).map((item) => [item.id, item]));
    for (const item of Array.isArray(updates) ? updates : []) {
      const id = clean(item?.id, 64) || randomUUID();
      byId.set(id, { ...(byId.get(id) || {}), ...item, id });
    }
    return [...byId.values()].filter((item) => item?.[textField]);
  };
  const recentBeat = patch.recentBeat && typeof patch.recentBeat === 'object' && clean(patch.recentBeat.summary, 180)
    ? { sequence: Math.max(0, Number(beatSequence) || 0), type: BEAT_TYPES.has(patch.recentBeat.type) ? patch.recentBeat.type : 'reflection', summary: clean(patch.recentBeat.summary, 180) }
    : null;
  return cleanStoryState({
    ...base,
    arcPhase: patch.arcPhase ?? base.arcPhase,
    tension: patch.tension ?? base.tension,
    pacing: patch.pacing ?? base.pacing,
    activeTensions: upsert(base.activeTensions, patch.upsertActiveTensions, removedTensions, 'summary'),
    openQuestions: upsert(base.openQuestions, patch.upsertOpenQuestions, removedQuestions, 'text'),
    recentBeats: recentBeat ? [...base.recentBeats, recentBeat] : base.recentBeats
  }, characterIds, base);
}

export function cleanStoryState(value = {}, characterIds = [], fallback = {}) {
  const allowed = new Set(characterIds);
  const source = value && typeof value === 'object' ? value : {};
  const base = { ...emptyStoryState(), ...(fallback && typeof fallback === 'object' ? fallback : {}) };
  const inheritedRhythm = source.rhythm ?? (fallback && typeof fallback === 'object' ? fallback.rhythm : null);
  const activeTensions = Array.isArray(source.activeTensions) ? source.activeTensions.slice(0, 5).map((item) => ({
    id: clean(item?.id, 64) || randomUUID(), summary: clean(item?.summary, 240),
    involvedCharacterIds: Array.isArray(item?.involvedCharacterIds) ? [...new Set(item.involvedCharacterIds.filter((id) => validId(id, allowed)))].slice(0, 6) : [],
    pressure: integer(item?.pressure, 0, 100, 40), introducedAtSequence: Math.max(0, Number(item?.introducedAtSequence) || 0)
  })).filter((item) => item.summary) : [];
  const openQuestions = Array.isArray(source.openQuestions) ? source.openQuestions.slice(0, 5).map((item) => ({
    id: clean(item?.id, 64) || randomUUID(), text: clean(item?.text, 240),
    involvedCharacterIds: Array.isArray(item?.involvedCharacterIds) ? [...new Set(item.involvedCharacterIds.filter((id) => validId(id, allowed)))].slice(0, 6) : [],
    urgency: integer(item?.urgency, 0, 100, 40), introducedAtSequence: Math.max(0, Number(item?.introducedAtSequence) || 0)
  })).filter((item) => item.text) : [];
  const recentBeats = Array.isArray(source.recentBeats) ? source.recentBeats.slice(-8).map((item) => ({
    sequence: Math.max(0, Number(item?.sequence) || 0), type: BEAT_TYPES.has(item?.type) ? item.type : 'reflection', summary: clean(item?.summary, 180)
  })).filter((item) => item.summary) : [];
  return {
    version: 1,
    arcPhase: ['setup','rising','turning','climax','aftermath'].includes(source.arcPhase) ? source.arcPhase : base.arcPhase,
    tension: integer(source.tension, 0, 100, integer(base.tension, 0, 100, 35)),
    pacing: ['slow','steady','fast'].includes(source.pacing) ? source.pacing : base.pacing,
    activeTensions, openQuestions, recentBeats, rhythm: cleanRhythmState(inheritedRhythm, recentBeats),
    lastDirectorSequence: Math.max(0, Number(source.lastDirectorSequence) || Number(base.lastDirectorSequence) || 0)
  };
}

export function cleanDramaticState(value = {}, characterIds = [], fallback = {}) {
  const allowed = new Set(characterIds);
  const source = value && typeof value === 'object' ? value : {};
  const base = { ...emptyDramaticState(), ...(fallback && typeof fallback === 'object' ? fallback : {}) };
  const participantSource = Array.isArray(source.participantIds) ? source.participantIds : base.participantIds;
  const participantIds = Array.isArray(participantSource) ? [...new Set(participantSource.filter((id) => validId(id, allowed)))].slice(0, 6) : [];
  const plannedSource = Array.isArray(source.plannedResponderIds) ? source.plannedResponderIds : base.plannedResponderIds;
  const plannedResponderIds = Array.isArray(plannedSource) ? plannedSource.filter((id) => validId(id, allowed)).slice(0, 2) : [];
  const planResponderSource = Array.isArray(source.planResponderIds) ? source.planResponderIds : base.planResponderIds;
  const planResponderIds = Array.isArray(planResponderSource) ? planResponderSource.filter((id) => validId(id, allowed)).slice(0, 2) : [];
  return {
    objective: clean(source.objective, 240, clean(base.objective, 240)),
    stakes: clean(source.stakes, 240, clean(base.stakes, 240)),
    dilemma: clean(source.dilemma, 240, clean(base.dilemma, 240)),
    beatType: BEAT_TYPES.has(source.beatType) ? source.beatType : (BEAT_TYPES.has(base.beatType) ? base.beatType : 'reflection'),
    targetTension: integer(source.targetTension, 0, 100, integer(base.targetTension, 0, 100, 35)),
    participantIds,
    beatIntent: RHYTHM_PHASES.has(source.beatIntent) ? source.beatIntent : (RHYTHM_PHASES.has(base.beatIntent) ? base.beatIntent : 'build'),
    outcomeConstraint: BEAT_OUTCOMES.has(source.outcomeConstraint) ? source.outcomeConstraint : (BEAT_OUTCOMES.has(base.outcomeConstraint) ? base.outcomeConstraint : 'open'),
    pressureSource: clean(source.pressureSource, 240, clean(base.pressureSource, 240)),
    reliefReason: clean(source.reliefReason, 240, clean(base.reliefReason, 240)),
    plannedResponderIds,
    planResponderIds,
    planStartedSequence: Math.max(0, Number(source.planStartedSequence ?? base.planStartedSequence) || 0),
    responsesConsumed: integer(source.responsesConsumed, 0, 2, integer(base.responsesConsumed, 0, 2, 0)),
    planAction: clean(source.planAction, 40, clean(base.planAction, 40)),
    planRationale: clean(source.planRationale, 500, clean(base.planRationale, 500)),
    planOperationId: clean(source.planOperationId, 64, clean(base.planOperationId, 64))
  };
}

export function publicStoryStatus(storyState, dramaticState, intensity) {
  const story = cleanStoryState(storyState);
  const scene = cleanDramaticState(dramaticState);
  return {
    intensity: DRAMA_INTENSITIES.has(intensity) ? intensity : 'balanced', tension: story.tension, arcPhase: story.arcPhase,
    objective: scene.objective, dilemma: scene.dilemma, rhythm: story.rhythm,
    activeTensions: story.activeTensions.slice(0, 3).map(({ summary, pressure }) => ({ summary, pressure })),
    openQuestions: story.openQuestions.slice(0, 3).map(({ text, urgency }) => ({ text, urgency }))
  };
}

export function normalizeMemory(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function memoryKey(text) {
  const normalized = normalizeMemory(text);
  return normalized ? createHash('sha256').update(normalized).digest('hex') : null;
}

export function memorySimilarity(first, second) {
  const tokens = (text) => new Set(normalizeMemory(text).split(' ').filter((token) => token.length > 1));
  const a = tokens(first); const b = tokens(second);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / new Set([...a, ...b]).size;
}
