# Sceneweaver handoff

Last updated: 2026-09-03 (Asia/Seoul)

This file is the current operational handoff between Codex sessions on the home and work computers. Read it before editing, then replace stale status as part of every material implementation.

## Current baseline

- Branch: `main`
- Remote baseline before the current local work: `71e70fd feat: configure agent models and reasoning`
- One persistent Codex app-server process serves serialized requests.
- Each character and the World Director has a reusable thread id, but PostgreSQL remains authoritative.
- Runtime monitoring shows the active agent/thread, execution pipeline, waterfall, and duration timeline.

## Implemented in the current unpushed work

- Added `+ 새 월드` and a full conversational World Builder with chat on the left and editable live preview on the right.
- Active drafts, messages, structured world data, and their reusable Codex thread ids persist in PostgreSQL and survive refreshes.
- Each model response supplies a complete validated world, first Scene, 2–6 characters, initial relationships, a user-facing reply, and optional follow-up topics.
- Manual preview edits use the same server validator as model output.
- Final confirmation creates the project, initial template, characters, symmetric relationships, Scene 1 and participants in one transaction, then switches the browser to the new world.
- Draft generation, saving, cancellation and creation are serialized with a draft advisory lock.
- Runtime monitoring identifies World Builder runs and persistent World Builder threads separately from characters and the World Director.
- API verification now covers a disposable saved draft and complete project creation before exercising the existing event/turn flow.

## Database migration

- New migration: `db/011_world_creation_drafts.sql`
- It adds resumable world creation drafts and ordered builder messages.
- Run `npm run migrate` after pulling. It is safe to rerun.

## Verification completed

- `npm run check` and `npm run migrate` passed.
- Two real World Builder turns reused the same Codex thread, stored four ordered messages, kept three characters, and changed the draft to CHAT as requested.
- `npm run verify:api` passed. It created a disposable world from a saved draft with two characters and Scene 1, then verified the existing event and Codex progression flow.
- Desktop browser screenshot review confirmed the new entry button and two-column draft dialog fit at 1440×1000.

## Next checks

1. Exercise the World Builder on a narrow/mobile viewport and refine the stacked chat/preview height if needed.
2. Try simultaneous edits from two browser tabs and confirm the second action waits instead of overwriting the first.
3. Decide whether completed/cancelled draft history needs a separate archive UI; it is currently retained only in PostgreSQL.
4. Exercise a real CHAT project until all participants independently reach `대화 종료` and confirm the UI settles without extra messages.

## Known limitations

- Auto-progress and automatic event scheduling are browser-owned; closing the page stops them.
- Memory retrieval is importance/recency based and has no semantic index or consolidation yet.
- New worlds can be created, but project deletion and importing characters from another world are not implemented.
- Completed and cancelled World Builder drafts are retained in PostgreSQL but are not listed in the browser.

## Handoff checklist

```bash
git status
npm install
npm run migrate
npm run check
npm run verify:api
git add <intended files>
git commit -m "feat: describe the completed change"
git push origin main
```

On the next computer, start with:

```bash
git status
git pull --rebase origin main
npm install
npm run migrate
```
