# Sceneweaver architecture

## State ownership

One project is one `World` and one continuous history. PostgreSQL is authoritative; Codex threads are replaceable execution context.

- `projects`: world rules, drama intensity, `story_state`, Director thread and world event cursor
- `scenes`: CHAT/STORY presentation, physical/channel context, `dramatic_state`, summary and progress signal
- `characters`: world-local identity, initial profile, current state, active character thread and event cursor
- `relationships`: directed current and initial relationship labels/scores
- `scene_entries`: globally ordered user, character, Director and system Events
- `scene_participants` / `scene_entry_recipients`: presence and immutable visibility
- `character_memories`: private durable memories; archived memories remain auditable
- `world_operations`: durable infrastructure work queue
- `event_suggestion_batches`: manual ideas and Director major-decision batches
- `story_repair_proposals`: previewable continuity repairs for legacy worlds

Every WorldCharacter keeps at most one active Codex thread. The server starts it on first response, uses `turn/start` thereafter, resumes it after app-server reconnect, and reconstructs it from PostgreSQL when unavailable. Character threads roll over after 12 turns or 50,000 context tokens; the Director rolls over after 8 turns or 80,000 context tokens. The limits are configurable, and rollover hydrates a new thread from PostgreSQL. A persisted contract version also forces a one-time rollover when character/Director authority instructions change. Story calls use a neutral workspace so repository coding instructions do not enter their context. The World Director and each active World Builder draft likewise have their own persistent thread. One-shot character suggestions clean up their temporary thread.

## Story dynamics

`projects.story_state` holds the arc phase, tension, pacing, active tensions, open questions, recent beats, rhythm state and the last Director sequence. Rhythm records the current world function (`build/pressure/choice/consequence/release`), the result already established by observed history or a Director event (`open/success/qualified_success/setback`), repeated-result count and tension direction. `scenes.dramatic_state` holds the current objective, stakes, dilemma, beat type, target tension, explicit participant ids, the latest world phase/result/pressure, and a sanitized World Director audit (action, rationale, original/remaining reaction opportunities, source operation). Legacy beat fields are normalized into the new world-state names when read; no history rewrite is required. Character `current_state` holds the current goal, internal conflict, beliefs, commitments and development notes.

The World, World Director and WorldCharacters have separate authority. PostgreSQL World state is established fact. The Director acts as the world's causal resolver: it may create external events, adjudicate environment/rules/chance, move time/location and select characters who can perceive and react, but it may not prescribe their acceptance, refusal, emotion, dialogue or action. Each character independently owns its intent, speech, emotion and attempted action. A character may directly establish a self-controlled gesture (`SELF`). An interaction whose result belongs to another active character is `CHARACTER_ATTEMPT` with an explicit target and routes directly to that target without a Director call. Only an attempt whose outcome depends on the environment, chance or world rules is `WORLD_ATTEMPT`; a later Director event resolves it before another character response.

The user selects `gentle`, `balanced`, or `high` per world. This controls Director cadence and acceptable pressure; it does not select a model. Tension is a wave rather than a monotonic target: outside climax, a third consecutive rise is rejected, while release and unqualified success are valid after earned payoff. Repeated narrative function/outcome pairs must change without forcing an arbitrary disaster. Ordinary reversible developments may be inserted automatically. Irreversible developments are emitted as two or three `MAJOR` options, pause browser auto-progress, and require explicit apply or reject-all.

## Progression lifecycle

1. Acquire the project advisory lock and load active Scene, participants and story state.
2. Reuse a valid queue for the second character who already has an immediate opportunity to react. Otherwise, for STORY ask the persistent Director for a world resolution; for CHAT ask on a settled/stalled scene or after the intensity cadence (8/5/3 events).
3. The Director chooses `CONTINUE`, `INJECT_MINOR_EVENT`, `TRANSITION_SCENE`, or `PROPOSE_MAJOR`, evaluates only already-observed outcomes, returns a compact story-state patch plus public scene state, and queues one or two characters who can perceive and react. Responder reasons describe perception/opportunity only, never desired behavior. A later user/Director event, non-continue scene signal or unresolved `WORLD_ATTEMPT` invalidates the remaining queue. A `CHARACTER_ATTEMPT` replaces it with a direct one-character interaction queue.
4. Minor events and scene transitions are stored transactionally before character generation. A transition and the first response occur within the same durable progression operation.
5. Major proposals are stored without changing history; the operation completes with `awaitingDecision` and no character is called.
6. Each progression operation consumes only the next queued responder, retrieves newly visible Events and up to six active private memories, builds the bounded character prompt, and calls that character's persistent thread. The following browser operation can consume the second responder without another Director call.
7. Validate the compact character-state patch and resolution authority. `NONE` has no action requiring resolution, `SELF` is limited to an outcome the character directly controls, `CHARACTER_ATTEMPT` requires an active target and leaves the Scene open for that target, and `WORLD_ATTEMPT` stores only the attempt. In one transaction merge and store current character state, response/action scope and target, directed relationship changes, qualifying private memory, event cursor, and next queue. A character attempt routes directly to its target; a world attempt clears the queue so the Director must resolve it next.

If Codex times out or the app-server disconnects during a character step, the runner retries that generation once with a fresh app-server connection. A still-failing operation remains durable and can be resumed with `POST /api/operations/:id/retry`; completed Director events, scene transitions and character steps are reused instead of being generated twice.

If a pending `WORLD_ATTEMPT` exists but the Director incorrectly returns `CONTINUE`, semantic validation rejects it and immediately requests one corrected world judgment. A still-failing Director-stage operation has no character step and can also be requeued through the same retry endpoint.

A character response cannot directly complete or transition a Scene. Its `sceneSignal` is advisory. The Director evaluates the combined history on the next progression, and transitions require a meaningful time/place/situation discontinuity rather than a fixed minimum number of dialogue turns.

## Memory and state-change policy

Character output proposes a compact current-state patch, 0–100 memory importance, directed relationship label/score changes, and public response. The server merges the patch into authoritative DB state and keeps before/after snapshots only in the state-change audit. Memories below 60 are not stored. Exact and token-similar duplicates are skipped, and only the twelve strongest active memories per character remain active; older/weaker rows are archived, not deleted. State changes are audited through `character_change_proposals` after validation and application.

## Legacy-world repair

Legacy worlds whose `story_state` is empty **and which already contain event history** cannot progress until reviewed. A clean reset or cloned playthrough instead receives a deterministic initial story/scene state and never requires legacy repair. `POST /api/story-repair` asks the persistent Director to analyze existing Scenes, Events, relationships, character state and active memories. It creates a `PENDING` preview only and never rewrites event history. Apply is accepted only if the world sequence is unchanged, then atomically updates story/scene/character state, current relationships, participants and memory archive flags. Reject leaves story data unchanged. Stale proposals must be regenerated.

## World creation and reset

World Builder structured drafts include drama intensity, premise, reusable core tensions and an opening question. Creation assigns new world-local character ids and seeds non-empty story, Scene and character state. Builder dialogue never enters story history. Reset restores the initial story template; clone remaps stored character ids and never copies logs, memories or Codex thread ids.

Project lifecycle actions are intentionally separate from world-content editing in the browser. `＋ 새 월드` opens World Builder, while the menu beside the project selector contains clone-as-new-playthrough and destructive reset. The world editor changes only the selected world's content and runtime settings.

## Visibility and safety

Character prompts include only public world/Scene state, active participant routing IDs/names, that character's current profile/state/secret, its relevant directed relationships, its private active memories, and Events explicitly visible to it since its cursor. Routing IDs allow validated `CHARACTER_ATTEMPT` targets; other characters' secrets, memories and private Director state remain excluded. Event cursors advance only after response persistence succeeds.

The browser never receives Codex credentials or direct app-server access. Codex failures return errors; no hard-coded dialogue fallback is used. Story mutations use PostgreSQL transactions and project-scoped locking.

## Observability

Runtime telemetry is redacted and in-memory. The monitor shows active character/Director/World Builder threads, model and effort, thread turn/context-token counts, continuous timing charts, time to first token, World Director timing/action/rationale, established world condition, ordered reaction opportunities, consumed/remaining responders, and tension before/after. The Director endpoint exposes only this sanitized audit; prompts, private state snapshots, secrets, dialogue under generation and memory text are never exposed.

## Deferred work

- server-owned automatic progression jobs and SSE completion
- semantic memory retrieval and consolidation
- project deletion and cross-world character import UI
- explicit lorebook entries and keyword activation
