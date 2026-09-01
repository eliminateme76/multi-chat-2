# Sceneweaver handoff

Last updated: 2026-09-02 (Asia/Seoul)

This file is the current operational handoff between Codex sessions on the home and work computers. Read it before editing, then replace stale status as part of every material implementation.

## Current baseline

- Branch: `main`
- Remote baseline before the current local work: `5a6f019 feat: add persistent world director flow`
- One persistent Codex app-server process serves serialized requests.
- Each character and the World Director has a reusable thread id, but PostgreSQL remains authoritative.
- Runtime monitoring shows the active agent/thread, execution pipeline, waterfall, and duration timeline.

## Implemented in the current unpushed work

- Monitoring layout was compacted to avoid page scrolling and make current state more visible.
- The execution timeline was moved to the top and changed to proportional duration bars.
- Persistent character threads are identified by owner instead of appearing as one-shot completed calls.
- Director work becomes visible before its thread is created; typing state is shown only for character response steps.
- CHAT characters now return a structured `shouldRespond` decision. A pass creates no public message.
- Each active participant's private conversation-end vote is stored in `scene_participants`.
- A CHAT conversation is settled only when all active participants passed against the same latest scene sequence.
- Any new character message or event invalidates earlier end votes.
- Ordinary events may be injected during conversation. Automatic time transitions require unanimous settlement; manual time transitions are an explicit override.
- CHAT settlement pauses character auto-progress rather than creating a scene by itself.
- Automatic event cadence now counts persisted messages and uses a 12-message interval.
- Main UI and monitor show each character's `대화 종료` state.
- The world editor now supports `현재 진행 초기화` and `별도 진행 만들기`.
- Reset preserves the world/character/initial relationship template but clears scenes, dialogue, events, memories, operations and Codex thread links.
- Clone creates an independent selectable project from the same initial settings without changing the source progression.

## Database migration

- New migration: `db/008_conversation_settlement.sql`
- It adds `idle_at_sequence`, `idle_reason`, and `idle_at` to `scene_participants`.
- Run `npm run migrate` after pulling this change. It is safe to rerun.
- New migration: `db/009_project_playthroughs.sql`
- It adds the initial world snapshot and initial relationship values used by reset/clone.

## Verification completed

- `npm run check` passed.
- `npm run migrate` completed locally.
- Automatic time transition was verified to reject before model generation when the conversation is not settled.
- `npm run verify:api` passed after updating the verifier for queued progression operations and mid-conversation events.
- Disposable lifecycle verification passed: clone created an empty Scene 1 with all characters, an inserted event was then removed by reset, and the disposable project was deleted.

## Next checks

1. Exercise a real CHAT project until all participants independently reach `대화 종료` and confirm the UI settles without extra messages.
2. Test an ordinary automatic event during active conversation and confirm all prior end votes reset.
3. Test automatic `시간 전환` after unanimous settlement and confirm a new scene is created.
4. Review model pass frequency and adjust the CHAT prompt if characters end too early or keep repeating themselves.
5. Confirm reset/clone wording and placement on a narrow/mobile viewport.

## Known limitations

- Auto-progress and automatic event scheduling are browser-owned; closing the page stops them.
- Memory retrieval is importance/recency based and has no semantic index or consolidation yet.
- Project selection exists, but project creation/deletion UI does not.

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
