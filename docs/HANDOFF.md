# Sceneweaver handoff

Last updated: 2026-09-03 (Asia/Seoul)

## Current baseline

- Branch: `main`
- PostgreSQL is authoritative; character, Director and active World Builder threads are persistent and replaceable.
- One project is one continuous World. CHAT and STORY Scenes share the same Event history.
- Application and monitor are expected on ports 3000 and 3001.

## Implemented in this change

- Added world-specific drama intensity and durable story/Scene/character dramatic state.
- Replaced the browser's random 12-message automatic-event picker with a persistent World Director plan: continue, minor event, scene transition, or user-approved major proposal.
- Major irreversible proposals pause auto-progress and show two or three alternatives plus reject-all. Reversible minor events remain automatic.
- Director chooses one or two actual responders separately from Scene participants. Scene transitions use explicit participant ids and generate the first response in the same operation.
- Character turns persist bounded current-state snapshots and directed relationship labels/scores. Durable memory requires importance 60+, is deduplicated, capped at twelve active rows, and archived instead of deleted.
- Added AI-generated legacy-world repair preview/apply/reject. Event history is never rewritten and apply is sequence-checked and transactional.
- World Builder drafts capture intensity, premise, core tensions and an opening question; new worlds start with populated story, Scene and character state.
- The play UI shows compact story tension/objective/active tensions and major-decision cards. The monitor records Director planning/action and tension movement.

## Database migration

- Latest migration: `db/012_story_dynamics.sql`
- Adds project/Scene dramatic state, memory archive/dedupe columns, major-event metadata and `story_repair_proposals`.
- `npm run migrate` is safe to rerun.

## Verification completed

- `npm run check` passed.
- `npm run migrate` passed.
- `npm run verify:api` passed against a disposable world using the real Codex app-server. It created a structured world, ran Director planning plus persistent character responses, and preserved model/thread settings.

## Operational next checks

1. Review and apply the pending repair proposal for `느리게 도착한 마음` in the web UI.
2. Exercise a Director-generated major proposal and confirm apply/reject both resume progression.
3. Observe several STORY operations at each drama-intensity setting and tune prompt pressure if needed.
4. Test repair and major-decision dialogs on a narrow viewport.

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
git commit -m "feat: add persistent story dynamics"
git push origin main
```
