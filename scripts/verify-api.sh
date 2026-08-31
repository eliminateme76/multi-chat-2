#!/usr/bin/env bash
set -euo pipefail

cd /mnt/c/Users/user/Documents/GitHub/multi-ai-chat
npm run start >/tmp/sceneweaver.log 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  PGPASSWORD=sceneweaver_dev_password psql -h localhost -U sceneweaver -d sceneweaver <<'SQL' >/dev/null
DELETE FROM scene_entries WHERE event_text = '검증용 사건: 종소리가 울린다.';
DELETE FROM scene_entries WHERE dialogue = '…방금 일은 우연이 아닐지도 몰라요. 먼저 상황을 확인해야 합니다.';
UPDATE projects SET scene_number = 1, turn_number = 0, description = '늦은 밤. 폭풍우가 창을 두드리고, 오래된 마법서가 희미하게 빛난다.', director_note = '세라의 비밀을 둘러싼 긴장을 유지하세요. 루카에게는 아직 확실한 증거가 없습니다.' WHERE id = '00000000-0000-4000-8000-000000000001';
SQL
}
trap cleanup EXIT
sleep 2
curl --fail --silent http://127.0.0.1:3000/api/state >/tmp/sceneweaver-before.json
curl --fail --silent --request POST --header 'Content-Type: application/json' --data '{"text":"검증용 사건: 종소리가 울린다."}' http://127.0.0.1:3000/api/events >/tmp/sceneweaver-event.json
curl --fail --silent --request POST http://127.0.0.1:3000/api/turns >/tmp/sceneweaver-turn.json
node <<'NODE'
const fs = require('fs');
const before = JSON.parse(fs.readFileSync('/tmp/sceneweaver-before.json'));
const event = JSON.parse(fs.readFileSync('/tmp/sceneweaver-event.json'));
const turn = JSON.parse(fs.readFileSync('/tmp/sceneweaver-turn.json'));
if (event.logs.length !== before.logs.length + 1 || turn.logs.length !== event.logs.length + 1 || turn.logs.at(-1).type !== 'message') throw new Error('API persistence validation failed');
console.log(JSON.stringify({ beforeLogs: before.logs.length, afterEventLogs: event.logs.length, afterTurnLogs: turn.logs.length, sceneNumber: event.sceneNumber, turnNumber: turn.turn }, null, 2));
NODE