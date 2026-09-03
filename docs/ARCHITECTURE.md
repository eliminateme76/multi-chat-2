# Sceneweaver architecture

## Goals

Sceneweaver simulates characters acting inside a shared story world. Character identity and memory must not depend on an LLM thread. PostgreSQL is the source of truth; a Codex thread is a replaceable execution context.

The first production-oriented design combines the character-card swap pattern used by group role-play applications with an environment-oriented simulation loop:

```text
StoryRunner
  -> ResponderSelector (one structured AI selection per progression)
  -> ContextBuilder
       -> public world and active scene
       -> active character card and private facts
       -> relationships involving that character
       -> relevant private memories
       -> recent public group messages
  -> Codex app-server (one process, one active reusable thread per WorldCharacter)
  -> OutputValidator
  -> StateUpdater (one PostgreSQL transaction)
```

## Source-of-truth boundaries

PostgreSQL owns all durable state:

- `projects`: world-level rules and turn cursor
- `scenes`: time, location, public direction, private director state, summary and progress signal
- `characters`: character card, private goal/secret and current emotion
- `relationships`: directed relationship labels and scores
- `scene_entries`: ordered Events with actor and visibility metadata
- `scene_participants`: per-Scene presence windows and each participant's current conversation-end vote
- `scene_entry_recipients`: immutable per-event visibility snapshots
- `world_operations`: durable infrastructure queue, not story-domain session state
- `character_memories`: private observations available only to their owner
- `world_creation_drafts` and `world_creation_messages`: resumable pre-project World Builder conversations and their latest structured draft

Codex owns no authoritative state. A WorldCharacter stores one active thread id in PostgreSQL. It starts on that character's first response, resumes after app-server reconnects, and is rebuilt from PostgreSQL if unavailable. Character suggestion calls remain one-shot, while event suggestions share the World Director thread. A World Builder draft has a separate reusable thread while it is active, with PostgreSQL messages and `draft_data` available to rebuild that context if the thread is unavailable.

## Model and reasoning configuration

Runtime configuration is durable PostgreSQL state and is resolved before every call:

```text
Character model/effort override
  -> project character defaults
  -> server fallback

Director settings
  -> project director model/effort
  -> project character model fallback

Utility settings
  -> character suggestion and other one-shot helpers
```

The browser loads the live picker catalog through app-server `model/list`, including each model's supported reasoning efforts. The server validates project-level pairs against that catalog. `turn/start` always receives the effective `model` and `effort`, so a setting change applies on the next turn even when an existing persistent thread is resumed.

The top-level `AI 스레드 설정` dialog is the unified configuration surface for the selected world. It includes character defaults, the World Director, one-shot utility work, every character (including characters whose first thread has not started), and active World Builder drafts. Character rows may independently inherit the world model and reasoning effort; every row also shows whether it has a persistent thread and its shortened thread id.

`GET /api/runtime/settings` returns this complete project-scoped view. `PUT /api/runtime/settings` validates the whole submitted set against the current app-server model catalog before opening a PostgreSQL transaction, then updates project roles, character overrides, and active draft settings together. The transaction uses the project progression lock and each affected draft lock, so it cannot interleave with a progression or draft generation. A validation or ownership error rolls back the entire save. Thread-link columns are never updated by this path.

Changing a persistent character, Director, or World Builder model does not create a replacement thread. The newly resolved model and effort are supplied to the next `turn/start`. Utility work remains intentionally one-shot and cleans its temporary thread after use.

Runtime monitoring records and displays the effective pair. Playthrough cloning copies all runtime settings and character overrides; reset preserves them.

## World templates and playthroughs

Each project is one independent playthrough. `projects.initial_world`, each character's `initial_profile`, and each relationship's initial label/score form its restart template.

- Reset acquires the same project advisory lock used by progression, deletes scenes, entries, memories, suggestions and queued operations, restores initial character/relationship state, clears Codex thread links, and creates an empty Scene 1.
- Clone creates a new project id and new character ids from the source template. Portraits, model choices and character cards are copied, while messages, memories, operations and thread ids are not.
- The source playthrough is never modified by cloning.

## Conversational world creation

The World Builder exists before a new project and never writes directly into an active story. A browser starts an `ACTIVE` draft using the selected project's utility model and reasoning settings, then sends one user message at a time through a draft-scoped reusable Codex thread. Every successful response contains a user-facing reply and a complete structured draft for the world, first Scene, two to six characters, and meaningful initial relationships.

PostgreSQL remains authoritative during this workflow: successful user/assistant messages, the latest validated draft, and the thread link are persisted together. Manual preview edits pass through the same validator. Draft save, model generation, cancellation, and final creation share a draft-scoped advisory lock so concurrent browser requests cannot overwrite each other.

Final creation is explicit and transactional. It inserts a new project and `initial_world`, new character ids and `initial_profile` values, symmetric initial relationships, Scene 1, and its participants. Builder dialogue does not enter Scene history or character memory. After commit, the draft is marked `CREATED` and its Codex thread is cleaned up on a best-effort basis.

Reset is deliberately destructive and requires browser confirmation. Clone is the safe choice when the existing progression must remain available.

## Visibility model

The Context Builder may send a character:

- public world rules and active-scene information;
- the character's own card, goal, secret, emotion and private memories;
- relationships that involve the character;
- public scene entries.

It must not send:

- another character's goal, secret or private memories;
- `private_director_state`;
- hidden world facts that have not become public entries.

`public_direction` is safe for both the UI and character prompts. `private_director_state` is server-only.

## Turn lifecycle

1. Acquire a project-scoped advisory lock.
2. Load the active scene and public state.
3. For CHAT auto-progress, enqueue every active participant so each can independently answer or pass. STORY/Manual progression uses the selected responders.
4. Retrieve up to six private memories by importance and recency.
5. Build a bounded prompt from the scene summary, six recent public entries and active character context.
6. Generate structured output including `shouldRespond` and a private `silenceReason`, plus dialogue, action, emotion, optional private memory, relationship changes and scene signal.
7. Validate identifiers, lengths, deltas and signal values.
8. In one transaction, either append and apply a public response or store only that participant's conversation-end vote. A public response or a new event invalidates all prior votes.
9. Release the lock and return public state.

No partial model result is persisted.

## Speaker selection

The initial selector is deterministic round-robin. Keeping it behind a module allows later rules such as participant presence, response urgency, cooldowns or an occasional LLM selector without changing generation or persistence code.

## CHAT settlement and events

Conversation settlement is a derived state, not a public chat message. A CHAT scene is settled only when every active participant has returned `shouldRespond=false` against the same latest scene-entry sequence. The vote stores a private reason for diagnostics, and becomes stale as soon as any character speaks or any event is appended.

Events and time progression have deliberately different gates:

- ordinary, contact, surprise, relationship and similar events may be injected during an active conversation;
- automatic time transitions require unanimous settlement;
- a user-selected time transition is an explicit override and may be applied immediately;
- CHAT settlement does not itself create a new scene. It pauses character auto-progress and waits for an event;
- STORY scenes continue to use `sceneSignal=complete` and Director-controlled scene transition.

Automatic event cadence counts persisted character messages, not progression requests or silent decisions. The browser currently requests an event after 12 messages; before settlement it excludes `시간 전환` from the allowed automatic event types.

## Memory policy

Memory records are private and auditable. The first version avoids embeddings:

- model proposes a concise memory and importance from 0 to 100;
- the server associates it with the generating message;
- retrieval orders by importance and recency;
- only the owning character receives it.

Embedding retrieval may be added after the memory volume justifies it. The authoritative text records must remain usable without the index.

## Orchestration policy

The character model may return `sceneSignal` as `continue`, `stalled`, or `complete`. This signal does not autonomously invent an event. It changes the public direction shown to the user and allows later orchestration rules to intervene. This avoids a second LLM call on every turn.

A future Director may run only on explicit events, scene completion or repeated stalls. It should select speakers, create scene transitions and inject world events, but not write character dialogue.

## Performance and failure behavior

- One Codex app-server process is reused.
- App-server config, authentication, logs and sessions are isolated under `SCENEWEAVER_CODEX_HOME`.
- Completed one-shot threads are unsubscribed and deleted so they do not accumulate in Codex session listings.
- Generation requests are serialized because story state is order-dependent.
- Every request uses a bounded context.
- A timeout destroys the unhealthy app-server; the next request starts a new one.
- PostgreSQL advisory locks prevent concurrent turns for the same project.
- Browser auto-progress is a convenience only; moving run state to a server-side job queue is a future production step.

## Runtime observability

`runtime-telemetry.js` retains the latest 50 in-memory runs and broadcasts redacted updates through Server-Sent Events. `/monitor.html` renders the pipeline and waterfall from `/api/runtime/snapshot` and `/api/runtime/events`.

Measured stages include state loading, speaker selection, memory retrieval, context construction, queue wait, app-server readiness, thread creation, model generation, output validation, and the database transaction. Metadata is limited to identifiers, counts, character lengths, model name, process ID and timings. Prompt text, secrets and memory text are never included.

## Deferred work

- server-owned background run jobs with SSE updates;
- semantic memory retrieval and consolidation;
- participant entry/exit and scene-specific visibility;
- LLM Director invoked only on transition conditions;
- explicit lorebook entries activated by keywords;
- richer per-task utility profiles if character recommendation and other one-shot work need separate tuning.
