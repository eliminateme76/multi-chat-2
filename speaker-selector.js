export function selectNextSpeaker(state) {
  if (!state.characters.length) throw new Error('At least one character is required.');
  return state.characters[state.turn % state.characters.length];
}
