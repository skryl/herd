## Title
Move Work Stage Persistence Into SQLite And Remove `work/`

## Status
Completed

## Date
2026-03-23

## Context
Herd still persists work-stage document content on disk under `work/`, while SQLite stores only work metadata and stage file paths. That splits the work model across two persistence layers, leaks filesystem paths through the public work payload, and leaves a repo-local `work/` directory as a second source of truth.

The goal is to make SQLite the only persistence layer for work items and work-stage content, remove `work/` from the product model, and delete the directory outright.

## Goals
- Store work-stage content in SQLite instead of filesystem markdown files.
- Remove `file_path` from the work stage model and all public APIs.
- Read work previews from SQLite.
- Migrate existing `work_stage.file_path` rows and on-disk content into SQLite in one cut.
- Remove the legacy `work/` directory from the repo/runtime model and stop recreating it.

## Non-goals
- Adding a new work-stage editor or write API.
- Reworking work stage names, ordering, status flow, or ownership rules.
- Preserving any legacy file-based compatibility path after the migration completes.

## Scope
- SQLite schema and migration logic
- Rust work model and commands
- Frontend/shared work types and work card rendering
- Work tests and migration coverage
- Docs that still describe `work/` as persistent storage
- Removal of the checked-in/generated `work/` directory

## Risks and mitigations
- Risk: existing stage content is lost during migration.
  - Mitigation: migrate by reading the recorded stage file paths into the new SQLite column before dropping the old table.
- Risk: a missing legacy file prevents startup.
  - Mitigation: migrate missing legacy files to an explicit placeholder document so startup and cleanup can still complete without silently writing empty content.
- Risk: public UI/tests still depend on `file_path`.
  - Mitigation: remove the field from shared types in the same change and update work-card/test expectations together.

## Acceptance criteria
- `work_stage` stores `content`, not `file_path`.
- Work stage preview reads from SQLite only.
- `WorkStageState` no longer exposes `file_path` publicly.
- No runtime code creates, reads, or deletes `work/session-*/...` markdown files.
- Existing file-backed work data is migrated into SQLite before the old schema is removed.
- The repo/runtime `work/` directory is removed.

## Phased Plan (Red/Green)

### Phase 0
Objective: Lock the desired DB-backed work model.

Red:
- Add failing tests for:
  - work creation storing stage content in SQLite without creating files
  - reading work-stage preview from SQLite-backed content
  - migrating legacy `work_stage.file_path` rows into DB content
- Expected failure signal:
  - stage files are still created/read from disk
  - schema still expects `file_path`

Green:
- Write this PRD and define the DB-backed work contract and migration behavior.

Verification commands:
- targeted Rust tests after each phase

Exit criteria:
- The migration and model cutover are explicit and testable.

### Phase 1
Objective: Move the backend work model from file paths to DB content.

Red:
- Add failing backend tests for the new `work_stage.content` storage and migration.
- Expected failure signal:
  - `file_path` still exists in the schema/model
  - previews still read from disk

Green:
- Change schema and migration logic.
- Store default stage content in SQLite on work creation.
- Read previews from SQLite.
- Remove file-based work creation/deletion logic.

Verification commands:
- `cargo test --manifest-path src-tauri/Cargo.toml work::tests`
- `cargo test --manifest-path src-tauri/Cargo.toml db::tests`

Exit criteria:
- Backend work persistence is SQLite-only.

### Phase 2
Objective: Remove filesystem-shaped work data from public contracts and docs.

Red:
- Add failing TS/unit coverage where `WorkStageState.file_path` no longer exists.
- Expected failure signal:
  - shared types and UI still depend on `file_path`

Green:
- Update shared types, work card rendering, and related tests.
- Update docs to describe SQLite-backed work-stage content.
- Remove the checked-in/generated `work/` directory.

Verification commands:
- `npm run check`
- targeted TS/unit/integration type checks
- `git diff --check`

Exit criteria:
- Public work models no longer leak file paths, docs match the new model, and `work/` is gone.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `rg -n "work/session|plan.md|artifact.md|file_path|work/|create_work_item|work_stage" src-tauri src tests docs README.md prd -g '!src-tauri/target'`
   - result: pass
   - notes: confirmed work stage content is still file-backed, `file_path` is public, and docs still describe `work/` as persistent storage.
2. `cargo test --manifest-path src-tauri/Cargo.toml work::tests`
   - result: fail
   - notes: red signal was `unresolved import super::read_current_stage_preview_at` after adding SQLite-preview expectations.
3. `cargo test --manifest-path src-tauri/Cargo.toml db::tests`
   - result: fail
   - notes: the same red compile break blocked the DB migration tests before the backend cutover existed.
4. `cargo test --manifest-path src-tauri/Cargo.toml work::tests`
   - result: pass
   - notes: work creation now stores stage content in SQLite, previews read from SQLite, and no stage files are created.
5. `cargo test --manifest-path src-tauri/Cargo.toml db::tests`
   - result: pass
   - notes: legacy `file_path` rows migrate into `content`, including explicit placeholder content when the old file is already missing.
6. `cargo test --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: full Rust suite is green after the schema, work model, command, and startup cleanup changes.
7. `npm run check`
   - result: pass
   - notes: shared TypeScript work models compile after removing `file_path`.
8. `npx tsc --noEmit --target ES2023 --lib ES2023 --module ESNext --moduleResolution bundler --allowImportingTsExtensions --verbatimModuleSyntax --strict --skipLibCheck --types node,vitest/globals tests/integration/*.ts`
   - result: pass
   - notes: integration suite typechecks with the updated work payload shape.
9. `npx vitest run src/lib/stores/appState.test.ts`
   - result: pass
   - notes: frontend state tests pass after removing `file_path` from sample work items.
10. `python3 - <<'PY' ... migrate tmp/*.sqlite work_stage rows from file_path to content and remove work/ ... PY`
   - result: pass
   - notes: migrated the current local runtime SQLite files in `tmp/` and removed the repo `work/` directory after migration.
11. `for db in tmp/*.sqlite; do sqlite3 \"$db\" \".schema work_stage\"; done`
   - result: pass
   - notes: verified every local runtime database now uses `work_stage(... content TEXT NOT NULL ...)`.
12. `ls -ld work 2>/dev/null || true`
   - result: pass
   - notes: confirmed the repo `work/` directory is gone.
13. `git diff --check`
   - result: pass
   - notes: no patch formatting or whitespace issues remain.
