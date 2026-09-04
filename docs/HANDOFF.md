# Sceneweaver Concordia handoff

Last updated: 2026-09-04 (Asia/Seoul)

## Current baseline

- Branch: `main`; repository: `eliminateme76/multi-chat-2`.
- This is the Concordia-only comparison fork. The original `multi-chat` repository is not modified by this work.
- PostgreSQL remains authoritative. Concordia entities/components are reconstructed for each step and Codex threads remain replaceable context.
- Local defaults are database `sceneweaver_concordia`, application port `3200`, and `gdm-concordia==2.4.0`.
- No OpenAI API key is used. Node owns the authenticated Codex app-server process under `SCENEWEAVER_CODEX_HOME`.

## Local runtime status

- The ignored local `.env` uses database `sceneweaver_concordia`, `HOST=127.0.0.1`, `PORT=3200`, `SCENEWEAVER_CODEX_HOME=/root/.codex-sceneweaver-concordia`, and `SCENEWEAVER_AGENT_CWD=/root/.codex-sceneweaver-concordia/workspace`.
- The dedicated Codex home was authenticated independently with ChatGPT on 2026-09-04. No credential or `auth.json` was copied from `/root/.codex-sceneweaver`.
- The previous `multi-chat-2` server using `/root/.codex-sceneweaver` was identified by its port, process group and working directory, then stopped without affecting other Node processes.
- The replacement server is running from `/home/codex_home/multi-chat-2` on `127.0.0.1:3200`. A real `model/list` request started its child app-server with `CODEX_HOME=/root/.codex-sceneweaver-concordia` and returned seven models.
- No Windows `portproxy` or firewall inbound rule was added. Keep the service localhost-only.

## Implemented in this change

- Added a persistent Python JSONL worker in `concordia_runtime/` using real Concordia `EntityAgentWithLogging`, `ContextComponent`, `ActingComponent`, `ActionSpec`, and a bounded custom `Engine`.
- Added `concordia-client.js`. The worker requests structured model samples through reverse stdio RPC; Node calls the existing Codex app-server and returns the validated result. Python opens no port and receives no auth material.
- Routed both character progression and World Director progression through the Concordia worker. World Builder, repair and suggestion utilities intentionally remain direct Codex utility calls.
- Kept one character response maximum per `POST /api/turns` operation.
- Added a mandatory post-character World GM judgment. The GM may resolve world-only consequences, inject a reversible event, transition a scene, propose a major decision, and schedule the next perceiving responder.
- Preserved character authority: `CHARACTER_ATTEMPT` forces the targeted active character as the next responder and explicitly forbids the GM prompt from deciding acceptance/refusal. `WORLD_ATTEMPT` is resolved before the same operation completes.
- Added durable `GM_PENDING` and `GM_COMPLETED` payload checkpoints. Character persistence and `GM_PENDING` commit together; a failed post-GM stage can be retried without duplicating the character Event.
- Added engine/version metadata to project state, durable operation payload/results, runtime telemetry and the UI badge.
- Added monitor visibility for the Concordia worker plus character Entity and World GM stages. Worker overhead is recorded separately from nested model duration to avoid timing double-counting.
- Advanced character/Director prompt contract version to 3; active v2 threads roll over once on next use.
- Added Python unit tests with a fake reverse model bridge, a worker protocol round trip, and third-party attribution.

## Database migration

- Latest migration: `db/016_concordia_engine.sql`.
- Adds `projects.simulation_engine` and `projects.simulation_engine_version`, fixed to `concordia` / `2.4.0` in this fork.
- Changes new character/Director thread contract defaults to version 3 and marks older active threads for one rollover.
- `npm run migrate` is safe to rerun.

## Verification completed

- `npm run check`: passed, including Node syntax checks, Python compilation and 4 pytest tests.
- 2026-09-04 dedicated-home cutover: `npm run migrate`, `npm run check`, and `npm run verify:latency-logic` passed; `CODEX_HOME="$SCENEWEAVER_CODEX_HOME" codex login status` reported `Logged in using ChatGPT`.
- After restart, `GET /api/state` returned `concordia/2.4.0`, turn 0 and the three initial demo logs. `GET /api/runtime/snapshot` returned a healthy runtime, and `GET /api/models` started the app-server under the dedicated home and returned seven models.
- `npm run db:setup`: passed against a new local `sceneweaver_concordia` database.
- `npm run verify:api`: passed with real Codex app-server calls on the disposable API world. It verified engine/version/checkpoints, one character per operation, mandatory post-GM judgment, contract v3, monitor telemetry, World Builder, settings, reset and clone. The full first operation took 53.7s and the queued-responder operation took 40.2s.
- Real Codex app-server progression operation `1eb0701f-93e8-4601-9f59-0f28c83b9ab8`: completed in 59.7s. It ran a Concordia GM pre-plan, one character Entity (세라), then a post-character GM judgment; the GM resolved `WORLD_ATTEMPT` as an `INJECT_MINOR_EVENT`/`qualified_success` and persisted `GM_COMPLETED`.
- Real operation `dabed3b2-332a-4187-900a-e4ade6283716`: completed in 60.7s with one character Event (루카), a same-operation post-GM world consequence, engine metadata, and Director thread resume/reuse.
- PostgreSQL inspection confirmed project engine `concordia/2.4.0` and successful character/Director thread contract version 3 persistence.

## Known tradeoffs / next checks

1. A STORY operation without a reusable reaction opportunity can perform GM pre-selection + character generation + mandatory post-GM judgment. The two real samples were about 60s; most time was Codex generation, not Python overhead (single-digit to low-hundreds of milliseconds after worker startup).
2. Exercise and visually inspect a `CHARACTER_ATTEMPT` in the browser to confirm the GM observes it while the named target stays next.
3. Force a post-character GM failure in an automated integration harness and assert retry leaves the character entry count unchanged. The database checkpoint/retry path is implemented; this failure injection is not yet automated.
4. Exercise a post-character `PROPOSE_MAJOR` and both apply/reject paths.
5. Browser auto-progress still stops when the page closes; server-owned job scheduling is deferred.
6. Memory retrieval remains importance/recency based; semantic retrieval is deferred.

## Setup on another computer

```bash
cd /home/codex_home/multi-chat-2
cp .env.example .env
python3 -m venv .venv
.venv/bin/pip install -r requirements-concordia.txt
npm install
sudo service postgresql start
sudo -u postgres createdb -O sceneweaver sceneweaver_concordia  # only if absent
set -a; . ./.env; set +a
CODEX_HOME="$SCENEWEAVER_CODEX_HOME" codex login status
npm run db:setup
npm run check
npm run dev
```

Do not copy or commit `.env` or Codex credentials. Log in to the separate app-specific Codex home on the target computer.
