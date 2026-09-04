# Sceneweaver — Codex Working Guide

## Project goal

Sceneweaver Concordia is a Korean interactive story simulator. Concordia 2.4 runs the World GM and character Entity lifecycle, Codex app-server supplies structured model actions, and PostgreSQL remains authoritative.

## Required environment

- Run application commands inside **WSL Ubuntu**, not native Windows Node.js.
- Repository path in this environment: `/home/codex_home/multi-chat-2`
- PostgreSQL runs inside WSL and is reached through the `DATABASE_URL` in `.env`.
- Codex CLI must be installed and authenticated in the app-specific `SCENEWEAVER_CODEX_HOME` under the same WSL user that runs Node:

  ```bash
  codex --version
  set -a; . ./.env; set +a
  CODEX_HOME="$SCENEWEAVER_CODEX_HOME" codex login status
  ```

## Start locally

```bash
cd /home/codex_home/multi-chat-2
sudo service postgresql start
npm install
python3 -m venv .venv
.venv/bin/pip install -r requirements-concordia.txt
npm run dev
```

Open `http://localhost:3200`. If WSL localhost forwarding is unavailable, find the WSL IP with `hostname -I` and open `http://<WSL_IP>:3200` from Windows.

## Cross-computer handoff workflow

This repository is worked on sequentially from two computers. GitHub `main` is the handoff channel; do not assume chat history is available on the other computer.

At the beginning of every Codex work session:

1. Read this file completely.
2. Read [docs/HANDOFF.md](./docs/HANDOFF.md) and the relevant sections of [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).
3. Inspect `git status` and recent commits before editing. Never discard carried-over user changes.
4. Apply pending migrations before running the application when HANDOFF reports schema changes.

After every material implementation, Codex must update documentation without waiting for a separate user request:

- update `docs/ARCHITECTURE.md` when boundaries, state, lifecycle, or behavior changed;
- update `docs/HANDOFF.md` with completed work, migrations, verification results, known issues, and the concrete next steps;
- remove stale items instead of only appending new notes;
- include the documentation changes in the same commit as the implementation they describe.

Before handing work to the other computer, run the relevant checks, commit all intended source and documentation changes, and push `main`. Never commit `.env`, credentials, local database files, or `node_modules`. If work is intentionally incomplete, use an explicit `wip:` commit and describe the exact continuation point in `docs/HANDOFF.md`.

## Core architecture

```text
Browser (index.html + app.js)
  → Express API (server.js)
    → PostgreSQL (projects, characters, relationships, scene_entries)
    → persistent Concordia Python worker over stdio JSONL (concordia-client.js)
      → Concordia Entity / Component / Engine lifecycle
      → reverse model callback to Node
        → Codex app-server over stdio JSON-RPC (codex-client.js)
```

### Critical behavior

- `POST /api/turns` enqueues one durable progression operation and generates at most one character response.
- `progression-runner.js` reconstructs Concordia entities from DB state. After every stored character action the Concordia World GM judges world-only consequences and schedules the next responder in the same durable operation.
- `context-builder.js` builds a bounded prompt from the active character card, related relationships, private memories, scene summary, and only recent **public** logs.
- The character model independently returns ordered dialogue/action blocks plus emotion and classifies resolution authority as self-controlled, targeted at another active character, or requiring a World judgment. Targeted interactions route directly to that character; World attempts route back through the Director. The actor never declares external success or another character's reaction.
- Model and reasoning effort are resolved from character override → role default → server fallback and are sent on every `turn/start`; do not make thread history authoritative for runtime configuration.
- Character persistence commits before GM judgment and marks the operation `GM_PENDING`; GM state/event/queue persistence atomically marks it `GM_COMPLETED`. Retrying the latter never regenerates the character entry.
- Portable `sceneweaver-world` files share initial world/cast/relationship/story setup across the original and Concordia apps. Imports always issue new world-local character ids and never carry Events, memories, threads, operations, model settings, or engine settings.
- Do not expose Codex auth details or app-server directly to the browser.
- Do not silently replace Codex failures with hard-coded dialogue. Return an API error instead.

## Codex app-server protocol currently used

`concordia-client.js` keeps one Python worker alive. The worker uses real `gdm-concordia==2.4.0` entities/components and asks Node for model samples by reverse JSONL RPC. `codex-client.js` keeps one app-server process alive under the isolated `SCENEWEAVER_CODEX_HOME`; no API key is used. Character turns reuse each WorldCharacter's persisted thread id; suggestion calls remain one-shot:

1. `initialize`
2. `initialized`
3. `thread/start` on first use/rollover or `thread/resume` after reconnect
4. `turn/start` with an `outputSchema`
5. Parse the `turn/completed` notification's final `agentMessage` JSON
6. Persist the successful character Event, cursor and thread link together

Character and Director threads roll over at configured turn/context-token limits and reconstruct from PostgreSQL. Story calls use `SCENEWEAVER_AGENT_CWD`, a neutral directory outside this repository, so development instructions do not enter story context.

Persistent story memory belongs in PostgreSQL, not in Codex thread history. See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for boundaries, visibility rules, and the turn lifecycle.

## Useful commands

```bash
# Syntax validation
npm run check

# Apply schema and initial demo project (safe to rerun)
npm run db:setup

# Reset current demo conversation to its 3 initial messages
npm run reset:demo

# API persistence check (uses a disposable project and temporary port 3101)
npm run verify:api

# Check database availability
pg_isready
```

## Current known limitations / next priorities

1. World Builder, repair, character and event suggestion utilities still call Codex directly; story progression uses Concordia.
2. Project deletion and cross-world character import UI are not implemented.
3. Memory retrieval currently uses importance and recency; semantic retrieval and consolidation are deferred.
4. Auto-progress is browser-owned; a production runner should use server-side jobs and SSE.

## Conventions

- UI text and prompts are Korean.
- Do not commit `.env`, `node_modules`, Codex credentials, or PostgreSQL data files.
- Keep data mutations transactional.
- Prefer structured model output schemas over parsing prose.
- Populate model/effort choices from Codex app-server `model/list`; do not hard-code a model's supported reasoning levels in the UI.
