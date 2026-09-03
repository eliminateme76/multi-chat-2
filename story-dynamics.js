import { createHash, randomUUID } from 'node:crypto';

export const DRAMA_INTENSITIES = new Set(['gentle', 'balanced', 'high']);
export const BEAT_TYPES = new Set(['connection', 'conflict', 'choice', 'setback', 'reveal', 'discovery', 'transition', 'reflection']);
export const DIRECTOR_ACTIONS = new Set(['CONTINUE', 'INJECT_MINOR_EVENT', 'TRANSITION_SCENE', 'PROPOSE_MAJOR']);

const clean = (value, max, fallback = '') => typeof value === 'string' ? value.trim().slice(0, max) : fallback;
const strings = (value, maxItems, maxLength) => Array.isArray(value) ? value.map((item) => clean(item, maxLength)).filter(Boolean).slice(0, maxItems) : [];
const integer = (value, min, max, fallback) => Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
const validId = (value, allowed) => typeof value === 'string' && allowed.has(value);

export function emptyStoryState() {
  return { version: 1, arcPhase: 'setup', tension: 35, pacing: 'steady', activeTensions: [], openQuestions: [], recentBeats: [], lastDirectorSequence: 0 };
}

export function emptyDramaticState() {
  return { objective: '', stakes: '', dilemma: '', beatType: 'reflection', targetTension: 35, participantIds: [] };
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

export function cleanStoryState(value = {}, characterIds = [], fallback = {}) {
  const allowed = new Set(characterIds);
  const source = value && typeof value === 'object' ? value : {};
  const base = { ...emptyStoryState(), ...(fallback && typeof fallback === 'object' ? fallback : {}) };
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
    activeTensions, openQuestions, recentBeats,
    lastDirectorSequence: Math.max(0, Number(source.lastDirectorSequence) || Number(base.lastDirectorSequence) || 0)
  };
}

export function cleanDramaticState(value = {}, characterIds = [], fallback = {}) {
  const allowed = new Set(characterIds);
  const source = value && typeof value === 'object' ? value : {};
  const base = { ...emptyDramaticState(), ...(fallback && typeof fallback === 'object' ? fallback : {}) };
  const participantIds = Array.isArray(source.participantIds) ? [...new Set(source.participantIds.filter((id) => validId(id, allowed)))].slice(0, 6) : [];
  return {
    objective: clean(source.objective, 240, clean(base.objective, 240)),
    stakes: clean(source.stakes, 240, clean(base.stakes, 240)),
    dilemma: clean(source.dilemma, 240, clean(base.dilemma, 240)),
    beatType: BEAT_TYPES.has(source.beatType) ? source.beatType : (BEAT_TYPES.has(base.beatType) ? base.beatType : 'reflection'),
    targetTension: integer(source.targetTension, 0, 100, integer(base.targetTension, 0, 100, 35)),
    participantIds
  };
}

export function publicStoryStatus(storyState, dramaticState, intensity) {
  const story = cleanStoryState(storyState);
  const scene = cleanDramaticState(dramaticState);
  return {
    intensity: DRAMA_INTENSITIES.has(intensity) ? intensity : 'balanced', tension: story.tension, arcPhase: story.arcPhase,
    objective: scene.objective, dilemma: scene.dilemma,
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
