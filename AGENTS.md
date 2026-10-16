# Instructions for AI Maintainers

Read `AI_HANDOFF.md` and `START_HERE.md` before changing or starting the application.
For a new computer or a repository-link installation request, begin with `AI_QUICK_START.md`; clone `main`, then use `npm run setup` and `npm run portable` for a fresh local SQLite library.

For code-only synchronization read `CODE_SYNC.md`. Do not initialize, commit or push a repository without the owner's approval and a reviewed source-only file list. Updates must not synchronize local libraries, credentials, or original media.

## Safety boundaries

- A fresh shared package uses SQLite; installing or configuring MySQL is NOT required.
- Never inspect, print, package, delete, or replace personal database credentials, API keys, vault keys, runtime exports, or the author's external application-data directory.
- Do not run against an existing user's library for tests. Use a fresh temporary `MEDIA_DATA_DIR` and `MEDIA_SKIP_IMPORT=1`.
- The original checkout's `npm start` may open an existing MySQL-backed library. `npm run portable` is the isolated sharing entry point; in generated packages `npm start` also uses portable mode.
- Do not remove an existing `mysql-connection.json` or silently switch a configured MySQL library to empty SQLite. A connection failure must stay visible.
- File rename, move, trash, and restore affect originals and require user confirmation. Test these only with disposable fixtures. Do not permanently delete original media.
- Do not call paid AI APIs to test; use mocks. Plus subscriptions are not API credentials.
- Only serve locally. Container binding to 0.0.0.0 is allowed inside Docker with host publishing restricted to 127.0.0.1. Do not remove session, origin, real-path, root-directory, or overwrite checks.
- `src/`, `server/`, `scripts/`, `tests/` are source. `dist/` is generated with `npm run build`; do not hand-edit it.
- Sharing is done through the audited allowlist in `scripts/package.mjs`, never by zipping the whole workspace, `node_modules`, `data`, `.runtime`, `reports`, or the home directory.
- Preserve unrelated user edits. Back up and validate data before schema or metadata migrations.

## Quick start for an unfamiliar machine

1. Verify Node 22.x and npm. Run `npm run setup`, then `npm run doctor`.
2. Run `npm run portable` or use the package's `npm start`. Note the actual printed port.
3. Add a user-selected directory in the UI, or use the absolute-path field. Start empty; do not invent the original author's paths.
4. Rebuild after changes. Run unit tests and applicable disposable integration tests.
5. Report untested OS/container behavior honestly. Read-only Docker is not a full macOS desktop replacement.
