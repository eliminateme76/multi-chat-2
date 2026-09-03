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

Every WorldCharacter keeps at most one active Codex thread. The server starts it on first response, uses `turn/start` thereafter, resumes it after app-server reconnect, and reconstructs it from PostgreSQL when unavailable. Character threads roll over after 12 turns or 50,000 context tokens; the Director rolls over after 8 turns or 80,000 context tokens. The limits are configurable, and rollover hydrates a new thread from PostgreSQL. Story calls use a neutral workspace so repository coding instructions do not enter their context. The World Director and each active World Builder draft likewise have their own persistent thread. One-shot character suggestions clean up their temporary thread.

## Story dynamics

`projects.story_state` holds the arc phase, tension, pacing, active tensions, open questions, recent beats, rhythm state and the last Director sequence. Rhythm records the current function (`build/pressure/choice/consequence/release`), planned result (`open/success/qualified_success/setback`), repeated-result count and tension direction. `scenes.dramatic_state` holds the current objective, stakes, dilemma, beat type, target tension, explicit participant ids and the current beat guidance. Character `current_state` holds the current goal, internal conflict, beliefs, commitments and development notes.

The user selects `gentle`, `balanced`, or `high` per world. This controls Director cadence and acceptable pressure; it does not select a model. Tension is a wave rather than a monotonic target: outside climax, a third consecutive rise is rejected, while release and unqualified success are valid after earned payoff. Repeated narrative function/outcome pairs must change without forcing an arbitrary disaster. Ordinary reversible developments may be inserted automatically. Irreversible developments are emitted as two or three `MAJOR` options, pause browser auto-progress, and require explicit apply or reject-all.

## Progression lifecycle

1. Acquire the project advisory lock and load active Scene, participants and story state.
2. Reuse a valid queued Director plan for its second responder. Otherwise, for STORY ask the persistent Director for a new plan; for CHAT ask on a settled/stalled scene or after the intensity cadence (8/5/3 events).
3. The Director chooses `CONTINUE`, `INJECT_MINOR_EVENT`, `TRANSITION_SCENE`, or `PROPOSE_MAJOR`, returns a compact story-state patch plus scene state, and queues one or two responders. A later user/Director event or non-continue scene signal invalidates the remaining responder.
4. Minor events and scene transitions are stored transactionally before character generation. A transition and the first response occur within the same durable progression operation.
5. Major proposals are stored without changing history; the operation completes with `awaitingDecision` and no character is called.
6. Each progression operation consumes only the next queued responder, retrieves newly visible Events and up to six active private memories, builds the bounded character prompt, and calls that character's persistent thread. The following browser operation can consume the second responder without another Director call.
7. Validate the compact character-state patch, including whether the character honored the planned beat result and supplied a real condition/cost for qualified success or setback. In one transaction merge and store current character state, the response, beat result, directed relationship changes, qualifying private memory, event cursor, and remaining responder queue.

If Codex times out or the app-server disconnects during a character step, the runner retries that generation once with a fresh app-server connection. A still-failing operation remains durable and can be resumed with `POST /api/operations/:id/retry`; completed Director events, scene transitions and character steps are reused instead of being generated twice.

A character response no longer directly completes and transitions a Scene. The Director evaluates the combined history on the next progression, preventing one character from forcing an immediate transition before others react.

## Memory and state-change policy

Character output proposes a compact current-state patch, 0–100 memory importance, directed relationship label/score changes, and public response. The server merges the patch into authoritative DB state and keeps before/after snapshots only in the state-change audit. Memories below 60 are not stored. Exact and token-similar duplicates are skipped, and only the twelve strongest active memories per character remain active; older/weaker rows are archived, not deleted. State changes are audited through `character_change_proposals` after validation and application.

## Legacy-world repair

Worlds whose `story_state` is empty cannot progress until reviewed. `POST /api/story-repair` asks the persistent Director to analyze existing Scenes, Events, relationships, character state and active memories. It creates a `PENDING` preview only and never rewrites event history. Apply is accepted only if the world sequence is unchanged, then atomically updates story/scene/character state, current relationships, participants and memory archive flags. Reject leaves story data unchanged. Stale proposals must be regenerated.

## World creation and reset

World Builder structured drafts include drama intensity, premise, reusable core tensions and an opening question. Creation assigns new world-local character ids and seeds non-empty story, Scene and character state. Builder dialogue never enters story history. Reset restores the initial story template; clone remaps stored character ids and never copies logs, memories or Codex thread ids.

Project lifecycle actions are intentionally separate from world-content editing in the browser. `＋ 새 월드` opens World Builder, while the menu beside the project selector contains clone-as-new-playthrough and destructive reset. The world editor changes only the selected world's content and runtime settings.

## Visibility and safety

Character prompts include only public world/Scene state, that character's current profile/state/secret, its relevant directed relationships, its private active memories, and Events explicitly visible to it since its cursor. Other characters' secrets, memories and private Director state are excluded. Event cursors advance only after response persistence succeeds.

The browser never receives Codex credentials or direct app-server access. Codex failures return errors; no hard-coded dialogue fallback is used. Story mutations use PostgreSQL transactions and project-scoped locking.

## Observability

Runtime telemetry is redacted and in-memory. The monitor shows active character/Director/World Builder threads, model and effort, thread turn/context-token counts, continuous timing charts, time to first token, Director-plan timing, Director action, and tension before/after. Prompts, secrets, dialogue under generation and memory text are never exposed.

## Deferred work

- server-owned automatic progression jobs and SSE completion
- semantic memory retrieval and consolidation
- project deletion and cross-world character import UI
- explicit lorebook entries and keyword activation
