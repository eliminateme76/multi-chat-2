# Sceneweaver handoff

Last updated: 2026-09-03 (Asia/Seoul)

## Current baseline

- Branch: `main`
- PostgreSQL is authoritative; character, Director and active World Builder threads are persistent and replaceable.
- One project is one continuous World. CHAT and STORY Scenes share the same Event history.
- Application and monitor are expected on ports 3000 and 3001.

## Implemented in this change

- Added `CHARACTER_ATTEMPT` plus an explicit active-character target. Interpersonal offers, requests, touch and conflict now route directly to the target character, who owns acceptance/refusal, without inserting a World Director event.
- Character prompts include the active participants' routing IDs and public names so structured interaction targets validate without exposing their private state.
- Kept `WORLD_ATTEMPT` only for environment, chance and world-rule outcomes. Interaction routing replaces the previous responder audit with `CHARACTER_INTERACTION`, remains visible in the monitor, and can chain reciprocal character choices without Director latency.
- Advanced the authority contract to version `2`, causing version-1 character and Director threads to roll over once on their next use.
- Added one corrective Director retry when a pending `WORLD_ATTEMPT` is incorrectly answered with `CONTINUE`; Director-stage failures with no character step can now be retried through the existing operation retry endpoint.
- Reframed the persistent Director as the World's causal resolver rather than a character script writer. Director responder reasons now describe only perception/opportunity, and its structured result evaluates already-established history or a world event instead of prescribing the next character's result.
- Removed Director-selected success/failure from character prompts and structured output. Characters independently choose acceptance/refusal, speech and action, and classify authority as `NONE`, self-controlled `SELF`, targeted `CHARACTER_ATTEMPT`, or unresolved `WORLD_ATTEMPT`.
- A `WORLD_ATTEMPT` is persisted without declaring external success, clears any second-responder queue, and forces the World Director to resolve the attempt before another character response. Legacy dramatic-state beat fields remain read-compatible and normalize to world phase/outcome/pressure fields.
- Added agent authority contract versions so existing character and Director threads roll over once instead of retaining conflicting old instructions.
- Updated the monitor to label the Director as a world judgment and show the latest established external condition rather than implying that it scripts the character's next result.
- Added a persistent, sanitized Director-plan audit and a prominent monitor card showing the action, rationale, ordered responders, completed/next/cancelled state, beat, source sequence, and whether the latest operation reused the plan. Raw prompts and private Director context remain unexposed.
- Reduced progression latency by persisting a Director responder queue for up to two character responses. Each operation now generates one response; the next operation can consume the queued responder without another Director call. New events and non-continue scene signals invalidate the queue.
- Replaced full character/story snapshots in routine model output with compact validated patches. Before/after character snapshots remain in the audit table, while public Event payloads store only the patch and visible result metadata.
- Added configurable character/Director thread rollover by turn count and context tokens. Existing threads are marked for one rollover, and successful calls persist turn/token counts transactionally before the old thread is cleaned up.
- Story model calls now use a neutral `SCENEWEAVER_AGENT_CWD`, preventing repository development instructions from consuming story context. Runtime telemetry records time-to-first-token and token counts, and the monitor shows persistent-thread turn/context usage.
- The play UI distinguishes World Director judgment from character generation while polling and can refresh after a completed response before operation finalization.
- Fixed playthrough cloning's ambiguous PostgreSQL parameter cast, which previously made `POST /api/projects/clone` fail before inserting cloned characters.
- Added world-specific drama intensity and durable story/Scene/character dramatic state.
- Replaced the browser's random 12-message automatic-event picker with a persistent World Director state: continue, minor event, scene transition, or user-approved major proposal.
- Major irreversible proposals pause auto-progress and show two or three alternatives plus reject-all. Reversible minor events remain automatic.
- Director chooses one or two characters with an immediate opportunity to react, separately from Scene participants. It does not choose their behavior. Scene transitions use explicit participant ids and generate the first response in the same operation.
- Character turns persist bounded current-state snapshots and directed relationship labels/scores. Durable memory requires importance 60+, is deduplicated, capped at twelve active rows, and archived instead of deleted.
- Added AI-generated legacy-world repair preview/apply/reject. Event history is never rewritten and apply is sequence-checked and transactional.
- Fixed clean reset/clone playthroughs inherited from pre-story-state worlds being mistaken for legacy history. They now receive a complete initial story/scene state; repair is gated only when empty state and existing events occur together. Migration 015 backfills already-created clean playthroughs.
- World Builder drafts capture intensity, premise, core tensions and an opening question; new worlds start with populated story, Scene and character state.
- The play UI shows compact story tension/objective/active tensions and major-decision cards. The monitor records Director world judgment/action and tension movement.
- Moved `현재 설정으로 새 진행` and destructive `현재 진행 처음부터 다시 시작` out of the world editor into the menu beside the current-project selector. `＋ 새 월드` remains a separate creation action.
- Added structured story rhythm so Director decisions distinguish build, pressure, choice, consequence and release. Tension direction must match its numeric change, cannot rise three times outside climax, and repeated function/result pairs are rejected.
- World Director resolutions persist `open/success/qualified_success/setback`; qualified success and setback require a concrete established consequence. Character responses no longer copy a preselected outcome.
- Transient character generation is retried once. A failed progression can be resumed through `POST /api/operations/:id/retry` without repeating its completed Director event or scene transition.

## Database migration

- Latest migration: `db/014_agent_authority_contract.sql`
- Adds character/Director thread contract versions. Any active thread below the current contract version `2` rolls over on its next call; successful calls persist version `2`.
- No JSON rewrite is needed; dramatic state normalizes on read and new character Event payloads carry `actionScope`.
- `npm run migrate` is safe to rerun.

## Verification completed

- `npm run check` passed.
- `npm run migrate` passed.
- `npm run verify:api` passed against a disposable world using the real Codex app-server. It created a structured world, generated `worldResolution` and independent character `actionScope` output, and preserved model/thread settings.
- The API verification also confirmed authority contract version persistence, one response per operation, token/counter metadata, and a second response that reused the queued reaction opportunity without a Director call. The latest run took 36.6s for Director+character and 10.0s for the reused character-only operation.
- After the `CHARACTER_ATTEMPT` change, the final real app-server API run passed in 31.6s for Director+character and 10.5s for the reused character-only operation; the assertion now accepts either a completed queue or a newly chained character-interaction queue.
- The production story `느리게 도착한 마음` was advanced from turn 43 to 46. A legacy `WORLD_ATTEMPT` was resolved once, then 서윤's question was stored as `CHARACTER_ATTEMPT(target=김재현)` and the next 25.1s operation called 재현 directly with `runtime.director=null`. The resulting dialogue remained coherent, and the monitor's interaction card was visually checked at 1920×1080.
- This playthrough exposed and verified fixes for two recovery cases: a Director incorrectly returning `CONTINUE` for a pending world attempt, and a character lacking public target IDs. The failed durable operations were retried without duplicating stored events.
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
