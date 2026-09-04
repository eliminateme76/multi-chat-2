# Sceneweaver Concordia handoff

Last updated: 2026-09-04 (Asia/Seoul)

## Current baseline

- Branch: `main`; repository: `eliminateme76/multi-chat-2`.
- This is the Concordia-only comparison fork with an independent repository and database; portable world files are its explicit interchange boundary with the original app.
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

- Fixed monitor continuity and live ownership. Sanitized completed/failed traces now persist in PostgreSQL (newest 500 per World, 200 loaded by the monitor), so detailed Concordia charts and history return after a server restart. Live SSE runs override persisted copies with the same id.
- Made an active `model_generate` stage mark an already-loaded character or World GM thread as running even when no `thread/start`/`thread/resume` stage occurs. New runs automatically take focus over a previously selected historical run; utility calls now say `일회성 작업` instead of being mislabeled as character threads, and an idle app-server is no longer colored as active.
- Split persistent story prompts into full hydration and routine deltas. First-use, contract-rollover and limit-rollover character/World GM threads receive the complete bounded DB context and authority contract; valid reused/resumed threads receive current mutable state plus only Events after their persisted cursor.
- Kept both modes inside the Concordia component/action-spec envelope and prepared a full wrapped prompt alongside every delta. If a saved Codex thread cannot be resumed, the same pending callback automatically uses full hydration rather than starting a replacement from an unusable standalone delta. Cursors still advance only after the character or GM transaction succeeds.
- Added privacy-safe `promptMode` and `promptCharacters` telemetry to model stages, Concordia callback runtime and durable progression results. Model, reasoning effort and output schema remain explicit on every turn. Advanced the Concordia story-agent contract to version `7` so existing character and Director threads hydrate once under the new contract.
- Separated authoritative world facts from narrative attention. Every pre/post Concordia GM judgment now classifies its impact as `WORLD_ONLY`, `SCENE`, or `ARC`; a server-side promotion gate prevents world-only details from changing recent beats, rhythm/tension, active questions/tensions, or the Scene objective.
- Made GM `recentBeat` nullable instead of forcing every judgment to become a beat. `SCENE` updates only immediate focus plus tension/pacing, while only `ARC` can change long-running tensions, questions, and arc phase.
- Removed duplicate identity, Scene, world and recent-log text from the Concordia adapter. Each authoritative context is now sent once, and operation results expose pre- and post-character promotion decisions separately.
- Persisted the sanitized promotion decision/reason with the responder plan and exposed it in the monitor. Advanced the Concordia character/Director contract to version `6` so existing threads roll over once.
- Added engine-neutral `sceneweaver-world` v1 export/import to the current-project menu. It transfers the initial world, cast, private character profiles, relationships and opening dramatic setup between the original and Concordia repositories, remaps all character ids, and intentionally excludes Events, progressed state, memories, threads, operations, runtime models and engine metadata.
- Added an explicit privacy confirmation before export because the portable file includes character secrets. Import validates and bounds the package, creates an independent project transactionally, and runs it with Concordia and the destination defaults.
- Made STORY dialogue less scripted: mutable beliefs/commitments/internal conflict are now explicitly private acting notes, responses normally focus on one central reaction in one or two natural sentences, established Korean speech level/pronouns stay consistent, and occupational metaphors are discouraged unless genuinely natural.
- Replaced fixed dialogue-then-action output with up to four ordered `DIALOGUE`/`ACTION` blocks throughout the Concordia character path. Blocks survive worker passthrough, validation, PostgreSQL persistence, later-agent context and browser rendering; flattened text columns remain populated for compatibility.
- Added narrative-salience rules to the Concordia character Entity and World GM prompts. Active questions, choices and relationships take priority, while nonessential regulations, procedures, equipment operation and fine physical traces are omitted or compressed.
- Improved long-form story readability with Noto Sans KR for content, larger and darker dialogue, non-italic action text, higher-contrast Director events, and clearer state/sidebar copy. This is presentation-only and does not alter Concordia progression or the preserved 50-turn comparison world.
- Added a persistent Python JSONL worker in `concordia_runtime/` using real Concordia `EntityAgentWithLogging`, `ContextComponent`, `ActingComponent`, `ActionSpec`, and a bounded custom `Engine`.
- Added `concordia-client.js`. The worker requests structured model samples through reverse stdio RPC; Node calls the existing Codex app-server and returns the validated result. Python opens no port and receives no auth material.
- Routed both character progression and World Director progression through the Concordia worker. World Builder, repair and suggestion utilities intentionally remain direct Codex utility calls.
- Kept one character response maximum per `POST /api/turns` operation.
- Added a mandatory post-character World GM judgment. The GM may resolve world-only consequences, inject a reversible event, transition a scene, propose a major decision, and schedule the next perceiving responder.
- Preserved character authority: `CHARACTER_ATTEMPT` forces the targeted active character as the next responder and explicitly forbids the GM prompt from deciding acceptance/refusal. `WORLD_ATTEMPT` is resolved before the same operation completes.
- Added durable `GM_PENDING` and `GM_COMPLETED` payload checkpoints. Character persistence and `GM_PENDING` commit together; a failed post-GM stage can be retried without duplicating the character Event.
- Added engine/version metadata to project state, durable operation payload/results, runtime telemetry and the UI badge.
- Added monitor visibility for the Concordia worker plus character Entity and World GM stages. Worker overhead is recorded separately from nested model duration to avoid timing double-counting.
- Added Python unit tests with a fake reverse model bridge, a worker protocol round trip, and third-party attribution.

## Database migration

- Latest migration: `db/017_runtime_traces.sql`.
- Migration 017 adds `runtime_traces` for redacted completed/failed monitor history. It cascades with the World and is capped to the newest 500 traces per World by runtime persistence.
- Adds `projects.simulation_engine` and `projects.simulation_engine_version`, fixed to `concordia` / `2.4.0` in this fork.
- Changes new character/Director thread contract defaults to version 3 and marks older active threads for one rollover.
- Runtime code now persists contract version 7 after successful story calls. No new migration is required because full/delta prompting reuses existing Event cursors and JSONB operation results.
- `npm run migrate` is safe to rerun.

## Verification completed

- `npm run migrate`, `npm run check` (including all 4 Concordia tests), and the real `npm run verify:api` passed with persisted runtime-history lookup and safe `promptMode` telemetry; sampled operations took 58.7s and 26.8s.
- The Concordia monitor was visually checked at 1920×1080 during a live model call and after a full Node restart. The live banner showed `일회성 작업 · 캐릭터 추천`, and the completed six-stage trace, chart, waterfall and history were restored from PostgreSQL after restart.
- `npm run check` passed, including all 4 Concordia tests; `npm run verify:latency-logic` passed for cursor-filtered character/GM deltas, smaller prompt assertions, and the resume-fallback full-hydration selector.
- `npm run verify:api` passed against the real Codex app-server and Concordia worker with contract version `7`. It verified first-character `full` hydration, same-character `delta` reuse with a smaller prompt, and a reused post-character GM delta; sampled operations took 57.6s and 26.3s (first GM delta 3,147 characters, first character full 3,274 characters).
- `npm run check` passed, including all 4 Concordia tests; `npm run verify:latency-logic` passed for all three promotion gates and the world-only no-op invariant.
- `npm run verify:api` passed against the real app-server and Concordia worker with contract version `6`, separately exposed pre/post promotion decisions, one response per operation, and the post-GM checkpoint; sampled operations took 55.3s and 30.2s.
- `npm run check` passed, including Node syntax checks, Python compilation and all 4 Concordia tests; `npm run verify:latency-logic` also passed with the natural-dialogue contract checks.
- `npm run verify:api` passed against the real Codex app-server and Concordia worker after the portability change. A disposable world exported and re-imported with three fresh character ids, no Events or threads, and `concordia/2.4.0` selected by the destination; sampled operations took 58.7s and 37.7s.
- `npm run check` passed with all 4 Concordia Python tests, and `npm run verify:latency-logic` passed for ordered block context reconstruction, legacy fallback and narrative-salience prompt rules.
- The localhost-only server on port 3200 was restarted from `/home/codex_home/multi-chat-2`; `/api/state` and the served ordered-block renderer responded successfully after restart.
- `npm run check` passed after the readability-only UI change. The shared story layout was visually checked at 1920×1080 in headless Chrome against the preserved comparison run.
- `npm run check`: passed, including Node syntax checks, Python compilation and 4 pytest tests.
- 2026-09-04 dedicated-home cutover: `npm run migrate`, `npm run check`, and `npm run verify:latency-logic` passed; `CODEX_HOME="$SCENEWEAVER_CODEX_HOME" codex login status` reported `Logged in using ChatGPT`.
- After restart, `GET /api/state` returned `concordia/2.4.0`, turn 0 and the three initial demo logs. `GET /api/runtime/snapshot` returned a healthy runtime, and `GET /api/models` started the app-server under the dedicated home and returned seven models.
- `npm run db:setup`: passed against a new local `sceneweaver_concordia` database.
- `npm run verify:api`: passed with real Codex app-server calls on the disposable API world. It verified engine/version/checkpoints, one character per operation, mandatory post-GM judgment, contract v3, monitor telemetry, World Builder, settings, reset and clone. The full first operation took 53.7s and the queued-responder operation took 40.2s.
- Real Codex app-server progression operation `1eb0701f-93e8-4601-9f59-0f28c83b9ab8`: completed in 59.7s. It ran a Concordia GM pre-plan, one character Entity (세라), then a post-character GM judgment; the GM resolved `WORLD_ATTEMPT` as an `INJECT_MINOR_EVENT`/`qualified_success` and persisted `GM_COMPLETED`.
- Real operation `dabed3b2-332a-4187-900a-e4ade6283716`: completed in 60.7s with one character Event (루카), a same-operation post-GM world consequence, engine metadata, and Director thread resume/reuse.
- PostgreSQL inspection confirmed project engine `concordia/2.4.0` and successful character/Director thread contract version 3 persistence.

## Known tradeoffs / next checks

1. A STORY operation without a reusable reaction opportunity can perform GM pre-selection + character generation + mandatory post-GM judgment. Compare `full` versus `delta` prompt size, time-to-first-token and total latency over several real turns; current input-token telemetry is total thread context, not just the latest prompt.
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
