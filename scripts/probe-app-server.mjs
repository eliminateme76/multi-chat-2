import { spawn } from 'node:child_process';

const appServer = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
appServer.stdout.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    console.log(`OUT ${line}`);
    const message = JSON.parse(line);
    if (message.id === 1 && message.result) appServer.stdin.write(`${JSON.stringify({ id: 2, method: 'thread/start', params: { model: 'gpt-5.6-sol', cwd: process.cwd(), approvalPolicy: 'never', sandbox: 'read-only', serviceName: 'sceneweaver' } })}\n`);
    if (message.id === 2 && message.result?.thread?.id) {
      appServer.stdin.write(`${JSON.stringify({ id: 3, method: 'turn/start', params: { threadId: message.result.thread.id, input: [{ type: 'text', text: 'Reply with exactly this JSON object: {"dialogue":"안녕하세요","action":"손을 흔든다","emotion":"기대"}. Do not use tools.' }, { type: 'text', text: 'Your output must follow the JSON schema.' }], outputSchema: { type: 'object', properties: { dialogue: { type: 'string' }, action: { type: 'string' }, emotion: { type: 'string' } }, required: ['dialogue', 'action', 'emotion'], additionalProperties: false } } })}\n`);
    }
    if (message.method === 'turn/completed') setTimeout(() => appServer.kill(), 200);
  }
});
appServer.stderr.on('data', (chunk) => process.stderr.write(`ERR ${chunk}`));
appServer.on('exit', (code) => console.error(`app-server exited: ${code}`));
appServer.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'sceneweaver-probe', version: '0.1.0' }, capabilities: {} } })}\n`);
appServer.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
setTimeout(() => { appServer.kill(); }, 90000);