# Sceneweaver handoff

Last updated: 2026-09-03 (Asia/Seoul)

## Current baseline

- Branch: `main`
- PostgreSQL is authoritative; character, Director and active World Builder threads are persistent and replaceable.
- One project is one continuous World. CHAT and STORY Scenes share the same Event history.
- Application and monitor are expected on ports 3000 and 3001.

## Implemented in this change

- Added a persistent, sanitized Director-plan audit and a prominent monitor card showing the action, rationale, ordered responders, completed/next/cancelled state, beat, source sequence, and whether the latest operation reused the plan. Raw prompts and private Director context remain unexposed.
- Reduced progression latency by persisting a Director responder queue for up to two character responses. Each operation now generates one response; the next operation can consume the queued responder without another Director call. New events and non-continue scene signals invalidate the queue.
- Replaced full character/story snapshots in routine model output with compact validated patches. Before/after character snapshots remain in the audit table, while public Event payloads store only the patch and visible result metadata.
- Added configurable character/Director thread rollover by turn count and context tokens. Existing threads are marked for one rollover, and successful calls persist turn/token counts transactionally before the old thread is cleaned up.
- Story model calls now use a neutral `SCENEWEAVER_AGENT_CWD`, preventing repository development instructions from consuming story context. Runtime telemetry records time-to-first-token and token counts, and the monitor shows persistent-thread turn/context usage.
- The play UI distinguishes Director planning from character generation while polling and can refresh after a completed response before operation finalization.
- Fixed playthrough cloning's ambiguous PostgreSQL parameter cast, which previously made `POST /api/projects/clone` fail before inserting cloned characters.
- Added world-specific drama intensity and durable story/Scene/character dramatic state.
- Replaced the browser's random 12-message automatic-event picker with a persistent World Director plan: continue, minor event, scene transition, or user-approved major proposal.
- Major irreversible proposals pause auto-progress and show two or three alternatives plus reject-all. Reversible minor events remain automatic.
- Director chooses one or two actual responders separately from Scene participants. Scene transitions use explicit participant ids and generate the first response in the same operation.
- Character turns persist bounded current-state snapshots and directed relationship labels/scores. Durable memory requires importance 60+, is deduplicated, capped at twelve active rows, and archived instead of deleted.
- Added AI-generated legacy-world repair preview/apply/reject. Event history is never rewritten and apply is sequence-checked and transactional.
- World Builder drafts capture intensity, premise, core tensions and an opening question; new worlds start with populated story, Scene and character state.
- The play UI shows compact story tension/objective/active tensions and major-decision cards. The monitor records Director planning/action and tension movement.
- Moved `현재 설정으로 새 진행` and destructive `현재 진행 처음부터 다시 시작` out of the world editor into the menu beside the current-project selector. `＋ 새 월드` remains a separate creation action.
- Added structured story rhythm so Director decisions distinguish build, pressure, choice, consequence and release. Tension direction must match its numeric change, cannot rise three times outside climax, and repeated function/result pairs are rejected.
- Character responses now persist `open/success/qualified_success/setback`; qualified success and setback require a concrete condition or cost. Earned success/release is explicitly allowed without an immediate artificial crisis.
- Transient character generation is retried once. A failed progression can be resumed through `POST /api/operations/:id/retry` without repeating its completed Director event or scene transition.

## Database migration

- Latest migration: `db/013_progression_latency.sql`
- Adds character/Director thread turn and context-token counters, rollover flags, and a recipient lookup index.
- `npm run migrate` is safe to rerun.

## Verification completed

- `npm run check` passed.
- `npm run migrate` passed.
- `npm run verify:api` passed against a disposable world using the real Codex app-server. It created a structured world, ran Director planning plus persistent character responses, and preserved model/thread settings.
- The API verification also confirmed one response per operation, persisted token/counter metadata, and a second response that reused the queued Director plan without a Director call.
- `npm run verify:latency-logic` passed for compact state patch merging, responder-queue cleaning, and visibility-safe recent context fallback.
- The real app-server API check also verified that the sanitized Director-plan endpoint reports the generated rationale/order and changes to reused/completed after the second operation. The monitor card was visually checked at 1920×1080 in both empty and populated states.
- A disposable clone using the production `gpt-5.6-sol` settings completed a fresh Director+character operation in 41.3s and a queued-plan character-only operation in 17.2s. The prior recent progression average was about 73s; this sample improved the full-plan request by 43% and the reused-plan request by 76% (model latency remains variable).

## Operational next checks

1. Observe several real-world progression pairs and compare first-operation (Director + character) versus reused-plan (character only) latency in the monitor.
2. Exercise a Director-generated major proposal and confirm apply/reject both resume progression.
3. Test repair and major-decision dialogs on a narrow viewport.

## Known limitations

- Browser auto-progress stops when the page closes; there is no server-owned job scheduler yet.
- Memory retrieval is importance/recency based, without embeddings.
- Project deletion and cross-world character import are not implemented.

## Handoff checklist

```bash
git status
npm install
npm run migrate
npm run check
npm run verify:api
git add <intended files>
git commit -m "perf: reduce progression latency"
git push origin main
```
