# Sceneweaver handoff

Last updated: 2026-09-03 (Asia/Seoul)

This file is the current operational handoff between Codex sessions on the home and work computers. Read it before editing, then replace stale status as part of every material implementation.

## Current baseline

- Branch: `main`
- One persistent Codex app-server process serves serialized requests.
- Each character and the World Director has a reusable thread id, but PostgreSQL remains authoritative.
- Runtime monitoring shows the active agent/thread, execution pipeline, waterfall, and duration timeline.
- Conversational World Builder drafts persist their own reusable thread until creation or cancellation.

## Implemented in this change

- Added a top-bar `AI 스레드 설정` dialog that configures every runtime role in the selected world from one screen.
- The screen groups character defaults, World Director, one-shot utility calls, every character, and active World Builder drafts. Persistent rows show their current thread id or that the first call is still pending.
- Character model and reasoning overrides can independently inherit the world defaults. Effective values update immediately in the form.
- Model choices and supported reasoning levels are refreshed from Codex app-server `model/list` whenever the dialog opens.
- Added project-scoped `GET/PUT /api/runtime/settings`. The PUT validates the complete payload against the live catalog, checks character/draft ownership, and saves project roles, character overrides, and active drafts in one locked PostgreSQL transaction.
- Runtime-setting saves never modify character, Director, or World Builder thread ids. Existing threads receive the changed model and effort on their next `turn/start`.
- Existing world and character edit forms read the refreshed state after a centralized save, while the monitor continues to resolve current effective values directly from PostgreSQL.

## Database migration

- No new migration is required for the unified runtime settings screen.
- Latest migration remains `db/011_world_creation_drafts.sql`; `npm run migrate` is safe to rerun after pulling.

## Verification completed

- `npm run check` and `npm run migrate` passed.
- `npm run verify:api` passed with a disposable world. It saved character and active World Builder settings as `gpt-5.6-luna / medium`, rejected and fully rolled back an unavailable model, and confirmed the next real progression used the configured pair.
- The same verification preserved all three generated character thread ids across another batch save and confirmed that restoring inheritance also preserved its character thread.
- Headless Chrome loaded the updated application successfully, initialized PostgreSQL state, and exposed the new accessible settings trigger and dialog without a page initialization error.

## Next checks

1. Exercise the settings dialog on a narrow/mobile viewport with six characters and several active drafts, then refine row density if necessary.
2. Try changing settings from two browser tabs while a long character or World Builder generation is running and confirm the second save waits and then refreshes cleanly.
3. Decide whether completed/cancelled World Builder draft history needs a separate archive UI; it is currently retained only in PostgreSQL.
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
