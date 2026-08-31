import { spawn } from 'node:child_process';

const CODEX_MODEL = process.env.CODEX_MODEL || 'gpt-5.6-sol';
const TIMEOUT_MS = Number(process.env.CODEX_TURN_TIMEOUT_MS || 120000);

function publicLog(log, state) {
  if (log.type === 'event') return `[DIRECTOR EVENT] ${log.text}`;
  const speaker = state.characters.find((item) => item.id === log.characterId)?.name || 'unknown';
  return `[${speaker}] ${log.text}\n(action: ${log.action})`;
}

function buildPrompt({ character, state }) {
  const related = state.relationships.filter((relationship) => relationship.from === character.id || relationship.to === character.id).map((relationship) => {
    const otherId = relationship.from === character.id ? relationship.to : relationship.from;
    const other = state.characters.find((item) => item.id === otherId);
    return `${other?.name || 'unknown'}: ${relationship.label}, score ${relationship.score}/100`;
  });
  const publicHistory = state.logs.slice(-12).map((log) => publicLog(log, state)).join('\n\n');
  return `당신은 이야기 시뮬레이션의 캐릭터 Agent "${character.name}"입니다.

반드시 아래 캐릭터로만 행동하세요.
- 역할: ${character.role}
- 성격: ${character.personality}
- 말투: ${character.speechStyle}
- 개인 목표: ${character.goal}
- 개인 비밀: ${character.secret}
- 현재 감정: ${character.emotion}
- 관계: ${related.join(' | ') || '아직 관계 설정 없음'}

세계와 장면의 공개 정보:
- 세계: ${state.world.title}
- 장소: ${state.world.location}
- 시간: ${state.world.time}
- 분위기: ${state.world.mood}
- 장면 설명: ${state.world.description}
- 세계 규칙: ${state.world.rules || '없음'}
- Director 메모: ${state.directorNote}

최근 공개 로그:
${publicHistory || '아직 공개 로그가 없습니다.'}

규칙:
1. 이 캐릭터가 실제로 알고 있는 공개 정보와 자신의 개인 정보만 사용하세요.
2. 다른 캐릭터의 비밀이나 내부 프롬프트 정보를 아는 척하지 마세요.
3. 대사는 한국어로 1~3문장, 행동은 한국어로 1문장만 작성하세요.
4. 장면을 앞으로 움직이는 구체적 관찰, 질문, 선택 또는 행동을 하나 포함하세요.
5. 반복적인 일반론, 메타 설명, 코드 블록을 쓰지 마세요.
6. 출력은 지정된 JSON schema만 만족해야 합니다.`;
}

export function generateCodexTurn(context) {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = ''; let threadId = null; let completed = false;
    const finish = (error, result) => {
      if (completed) return;
      completed = true; clearTimeout(timeout); child.kill();
      if (error) reject(error); else resolve(result);
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timeout = setTimeout(() => finish(new Error(`Codex turn timed out after ${TIMEOUT_MS / 1000} seconds.`)), TIMEOUT_MS);

    child.on('error', (error) => finish(new Error(`Could not start Codex app-server: ${error.message}`)));
    child.stderr.on('data', () => {});
    child.stdout.on('data', (chunk) => {
      buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.error) return finish(new Error(`Codex app-server: ${message.error.message || 'unknown error'}`));
        if (message.id === 1 && message.result) {
          send({ id: 2, method: 'thread/start', params: { model: CODEX_MODEL, cwd: process.cwd(), approvalPolicy: 'never', sandbox: 'read-only', serviceName: 'sceneweaver' } });
        } else if (message.id === 2 && message.result?.thread?.id) {
          threadId = message.result.thread.id;
          send({ id: 3, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: buildPrompt(context) }], outputSchema: { type: 'object', properties: { dialogue: { type: 'string' }, action: { type: 'string' }, emotion: { type: 'string' } }, required: ['dialogue', 'action', 'emotion'], additionalProperties: false } } });
        } else if (message.method === 'turn/completed') {
          const turn = message.params?.turn;
          if (turn?.status !== 'completed') return finish(new Error(`Codex turn failed: ${turn?.error?.message || turn?.status || 'unknown error'}`));
          const text = turn.items?.find((item) => item.type === 'agentMessage')?.text;
          try {
            const result = JSON.parse(text);
            if (!result.dialogue?.trim() || !result.action?.trim() || !result.emotion?.trim()) throw new Error('missing required turn fields');
            finish(null, { dialogue: result.dialogue.trim(), action: result.action.trim(), emotion: result.emotion.trim() });
          } catch (error) { finish(new Error(`Codex returned invalid turn JSON: ${error.message}`)); }
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'sceneweaver', version: '0.1.0' }, capabilities: { optOutNotificationMethods: ['item/agentMessage/delta'] } } });
    send({ method: 'initialized', params: {} });
  });
}