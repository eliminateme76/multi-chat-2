# Sceneweaver architecture

## State ownership

One project is one `World` and one continuous history. PostgreSQL is authoritative; Concordia entities are reconstructed execution objects and Codex threads are replaceable model context.

- `projects`: world rules, drama intensity, `story_state`, simulation engine/version, Director thread and world event cursor
- `scenes`: CHAT/STORY presentation, physical/channel context, `dramatic_state`, summary and progress signal
- `characters`: world-local identity, initial profile, current state, active character thread and event cursor
- `relationships`: directed current and initial relationship labels/scores
- `scene_entries`: globally ordered user, character, Director and system Events; new character responses keep ordered `DIALOGUE`/`ACTION` blocks in the JSON payload while legacy text columns remain populated for compatibility
- `scene_participants` / `scene_entry_recipients`: presence and immutable visibility
- `character_memories`: private durable memories; archived memories remain auditable
- `world_operations`: durable infrastructure work queue
- `event_suggestion_batches`: manual ideas and Director major-decision batches
- `story_repair_proposals`: previewable continuity repairs for legacy worlds

Every WorldCharacter keeps at most one active Codex thread. The server starts it on first response, uses `turn/start` thereafter, resumes it after app-server reconnect, and reconstructs it from PostgreSQL when unavailable. Character threads roll over after 12 turns or 50,000 context tokens; the Director rolls over after 8 turns or 80,000 context tokens. The limits are configurable, and rollover hydrates a new thread from PostgreSQL. A persisted contract version also forces a one-time rollover when character/Director authority instructions change. Story calls use a neutral workspace so repository coding instructions do not enter their context. The World Director and each active World Builder draft likewise have their own persistent thread. One-shot character suggestions clean up their temporary thread.

## Concordia runtime boundary

Story progression uses `gdm-concordia==2.4.0`. Node owns HTTP, PostgreSQL transactions, Codex threads and validation. A persistent Python worker owns Concordia execution only and communicates over stdio JSONL; it opens no port and holds no Codex credential or API key. For each step it constructs a real `EntityAgentWithLogging` from DB-derived context, executes a bounded custom `Engine`, and requests a structured model action through a reverse RPC to Node. Node then uses the existing Codex app-server process and returns the validated result. The adapter sends each authoritative prompt section once; it no longer duplicates identity, Scene, world, and recent log text through parallel snapshot/observation components.

Concordia component state is deliberately disposable. Identity, memory, relationships, visibility, scene state, cursors and GM decisions are reconstructed from PostgreSQL, so restarting either worker cannot fork the World. `projects.simulation_engine` and `simulation_engine_version`, operation results and telemetry identify `concordia` / `2.4.0`. Utility workflows (World Builder, suggestions and legacy repair) remain direct Codex calls because they are not simulation steps.

## Story dynamics

`projects.story_state` holds the arc phase, tension, pacing, active tensions, open questions, recent beats, rhythm state and the last Director sequence. Rhythm records the current world function (`build/pressure/choice/consequence/release`), the result already established by observed history or a Director event (`open/success/qualified_success/setback`), repeated-result count and tension direction. `scenes.dramatic_state` holds the current objective, stakes, dilemma, beat type, target tension, explicit participant ids, the latest world phase/result/pressure, and a sanitized World Director audit (action, rationale, original/remaining reaction opportunities, source operation). Legacy beat fields are normalized into the new world-state names when read; no history rewrite is required. Character `current_state` holds the current goal, internal conflict, beliefs, commitments and development notes.

The World, World Director and WorldCharacters have separate authority. PostgreSQL World state is established fact. The Director acts as the world's causal resolver: it may create external events, adjudicate environment/rules/chance, move time/location and select characters who can perceive and react, but it may not prescribe their acceptance, refusal, emotion, dialogue or action. Each character independently owns its intent, speech, emotion and attempted action. A character may directly establish a self-controlled gesture (`SELF`). An interaction whose result belongs to another active character is `CHARACTER_ATTEMPT` with an explicit target and routes next to that target; the GM still observes the turn but cannot resolve it. Only an attempt whose outcome depends on the environment, chance or world rules is `WORLD_ATTEMPT`; the post-character GM judgment resolves it before the operation completes.

World facts and narrative attention are distinct. Every necessary causal result remains an ordered Event, while each pre/post GM judgment separately classifies its narrative impact as `WORLD_ONLY`, `SCENE`, or `ARC`. `WORLD_ONLY` means no current goal, choice, relationship, stake, open question, or future option materially changed; the server therefore preserves story rhythm, recent beats, tensions, questions, and the Scene objective even if the model proposed changes. `SCENE` may update the immediate focus plus tension/pacing and add one beat, while `ARC` may also update arc phase, active tensions, and open questions. This promotion gate is domain-independent and enforced after model validation. Operation results expose pre- and post-character promotion decisions separately.

The user selects `gentle`, `balanced`, or `high` per world. This controls Director cadence and acceptable pressure; it does not select a model. Tension is a wave rather than a monotonic target: outside climax, a third consecutive rise is rejected, while release and unqualified success are valid after earned payoff. Repeated narrative function/outcome pairs must change without forcing an arbitrary disaster. Ordinary reversible developments may be inserted automatically. Irreversible developments are emitted as two or three `MAJOR` options, pause browser auto-progress, and require explicit apply or reject-all.

## Progression lifecycle

1. Acquire the project advisory lock and load the active Scene, participants and story state.
2. Reuse a valid reaction-opportunity queue, or run the Concordia World GM to establish any prerequisite world event/transition and select a perceiving responder.
3. Reconstruct that character as a Concordia Entity from its current DB profile/state, relationships, private memories and visible Events. Execute one bounded Engine step and call its persistent Codex thread for ordered `DIALOGUE`/`ACTION` blocks and structured authority/state output.
4. Validate block order and authority, then atomically persist at most one character Event, its ordered blocks and compatibility text, state/memory/relationship changes, cursor and thread link. Mark the durable operation `GM_PENDING` in the same transaction.
5. Re-read authoritative state and run the Concordia World GM after every character result. The GM may establish environment/chance/rule consequences, inject a minor event, transition the Scene, propose a user-approved major change, and schedule one or two perceiving responders.
6. The GM never resolves `CHARACTER_ATTEMPT`; that target is forced as the next responder and retains acceptance/refusal authority. A `WORLD_ATTEMPT` must be resolved in this same operation before completion.
7. Persist the GM event/scene/story patch, Director thread and next queue transactionally with `GM_COMPLETED`, then complete the operation. If the GM call fails, retry resumes at step 5 and does not regenerate the completed character Event. If final result serialization fails after `GM_COMPLETED`, retry skips both model calls and only finalizes the operation.

If Codex times out or the app-server disconnects during a character step, the runner retries that generation once with a fresh app-server connection. A still-failing operation remains durable and can be resumed with `POST /api/operations/:id/retry`. A completed character step plus `GM_PENDING` is a valid retry point; completed events, transitions and character entries are never regenerated.

If a pending `WORLD_ATTEMPT` exists but the Director incorrectly returns `CONTINUE`, semantic validation rejects it and immediately requests one corrected world judgment. A still-failing Director-stage operation has no character step and can also be requeued through the same retry endpoint.

A character response cannot directly complete or transition a Scene. Its `sceneSignal` is advisory. The Director evaluates the combined history on the next progression, and transitions require a meaningful time/place/situation discontinuity rather than a fixed minimum number of dialogue turns.

## Memory and state-change policy

Character output proposes a compact current-state patch, 0–100 memory importance, directed relationship label/score changes, and public response. The server merges the patch into authoritative DB state and keeps before/after snapshots only in the state-change audit. Memories below 60 are not stored. Exact and token-similar duplicates are skipped, and only the twelve strongest active memories per character remain active; older/weaker rows are archived, not deleted. State changes are audited through `character_change_proposals` after validation and application.

## Legacy-world repair

Legacy worlds whose `story_state` is empty **and which already contain event history** cannot progress until reviewed. A clean reset or cloned playthrough instead receives a deterministic initial story/scene state and never requires legacy repair. `POST /api/story-repair` asks the persistent Director to analyze existing Scenes, Events, relationships, character state and active memories. It creates a `PENDING` preview only and never rewrites event history. Apply is accepted only if the world sequence is unchanged, then atomically updates story/scene/character state, current relationships, participants and memory archive flags. Reject leaves story data unchanged. Stale proposals must be regenerated.

## World creation and reset

World Builder structured drafts include drama intensity, premise, reusable core tensions and an opening question. Creation assigns new world-local character ids and seeds non-empty story, Scene and character state. Builder dialogue never enters story history. Reset restores the initial story template; clone remaps stored character ids and never copies logs, memories or Codex thread ids.

Project lifecycle actions are intentionally separate from world-content editing in the browser. `＋ 새 월드` opens World Builder, while the menu beside the project selector contains clone-as-new-playthrough, portable world export/import, and destructive reset. The world editor changes only the selected world's content and runtime settings.

The versioned `sceneweaver-world` JSON package is the engine-neutral interchange boundary between this app and the original variant. It contains the initial world/Scene premise, drama settings, attribute schema, initial character profiles (including private secrets), initial directed relationships, tensions and open questions. Character references use package-local keys; import issues new project and character ids. It deliberately excludes progressed Events, current mutable state, memories, cursors, Codex threads, operations, runtime model choices and simulation-engine metadata, so import starts an independent Concordia playthrough under this app's engine and defaults. Export therefore warns that the downloaded file contains private character material.

## Visibility and safety

Character prompts include only public world/Scene state, active participant routing IDs/names, that character's current profile/state/secret, its relevant directed relationships, its private active memories, and Events explicitly visible to it since its cursor. Routing IDs allow validated `CHARACTER_ATTEMPT` targets; other characters' secrets, memories and private Director state remain excluded. Event cursors advance only after response persistence succeeds.

For new STORY responses, the play UI renders persisted content blocks in their stored order, so an action may precede dialogue or dialogue and action may alternate. Older rows without blocks retain their historical dialogue-then-action rendering. Concordia character and World GM prompts prioritize the active dramatic question, choice and relationship movement; procedural or forensic detail that does not affect them is compressed instead of recursively expanded. Character `beliefs`, `commitments` and `internalConflict` are acting notes rather than dialogue copy: a turn normally speaks one central reaction in one or two natural sentences, preserves the established honorific/pronoun register, and avoids repeated occupational metaphors.

The browser never receives Codex credentials or direct app-server access. Codex failures return errors; no hard-coded dialogue fallback is used. Story mutations use PostgreSQL transactions and project-scoped locking.

## Observability

Runtime telemetry is redacted and in-memory. The monitor shows the Concordia worker status/version, character Entity and World GM stages, active character/Director/World Builder Codex threads, model and effort, thread turn/context-token counts, continuous timing charts, time to first token, World Director timing/action/rationale, world-vs-narrative promotion decision, established world condition, ordered reaction opportunities, consumed/remaining responders, and tension before/after. Concordia stages record worker overhead separately from the nested model duration so charts do not double-count it. The Director endpoint exposes only this sanitized audit; prompts, private state snapshots, secrets, dialogue under generation and memory text are never exposed.

## Deferred work

- server-owned automatic progression jobs and SSE completion
- semantic memory retrieval and consolidation
- project deletion and cross-world character import UI
- explicit lorebook entries and keyword activation
