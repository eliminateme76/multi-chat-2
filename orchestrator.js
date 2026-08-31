export function publicDirectionForSignal(signal, characterName) {
  if (signal === 'stalled') return `전개가 반복되고 있습니다. ${characterName}의 발언을 계기로 새로운 관점이나 구체적인 선택을 드러내세요.`;
  if (signal === 'complete') return '현재 장면의 핵심 목표가 마무리되었습니다. 사용자가 새 사건을 투입하거나 다음 장면으로 전환할 수 있습니다.';
  return '공개된 정보와 각자의 목표에 따라 현재 장면을 한 단계 진행하세요.';
}
