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

Codex owns no authoritative state. A WorldCharacter stores one active thread id in PostgreSQL. It starts on that character's first response, resumes after app-server reconnects, and is rebuilt from PostgreSQL if unavailable. Suggestion calls remain one-shot and are deleted after completion.

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
- thread reuse as an optional cache, never as durable memory.
