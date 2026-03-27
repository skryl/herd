# Saved Session Configurations

## Status
Complete

## Date
2026-03-26

## Context
Herd sessions currently exist only as live tmux/runtime state. Users can rename tabs, arrange tiles, wire them together, minimize them, and configure browser/work tiles, but there is no way to save that arrangement as a reusable configuration or load one back into a tab. The requested behavior adds saved session configuration JSON files under `sessions/`, a toolbar dropdown to open a saved configuration into a new tab, and Settings controls to edit the current Session Name plus save/load the active tab layout by name.

## Goals
- Save the current session/tab arrangement as a JSON file under `sessions/` using the current Session Name.
- Load a saved session JSON into the current tab, replacing that tab’s non-root contents.
- Open a saved session configuration into a newly created tab from the toolbar.
- Persist all canvas tiles and connections: root agent, worker agents, shells, browser tiles, and work cards.
- Restore layout, minimization state, network connections, port settings, browser pages, and work card state.

## Non-goals
- Persisting canvas pan/zoom.
- Adding a file picker for arbitrary paths.
- Supporting multiple compatibility versions or legacy config schemas.
- Keeping the old session contents around after a load.

## Scope
- Backend save/list/load commands and JSON serialization under `sessions/`.
- Restore helpers for browser tiles, work cards, connections, port settings, and root-agent reuse.
- Frontend Tauri wrappers plus toolbar and sidebar UI.
- Focused unit and integration coverage for the saved configuration flow.

## Risks And Mitigations
- Minimized tile state currently lives only in frontend UI state.
  - Mitigation: pass minimized tile ids into save and return restored minimized tile ids from load so the frontend can reapply them directly.
- Loading into an existing tab can accidentally duplicate or destroy the root agent.
  - Mitigation: always reuse the existing session root tile and only destroy non-root windows.
- Browser tiles need to restore either extension pages or URLs.
  - Mitigation: save extension `load_path` when available, otherwise save the current navigated URL.
- Work cards need to survive recreation without stale runtime ids.
  - Mitigation: save logical node ids in the JSON and rebuild runtime tile/agent ids during load.

## Acceptance Criteria
- The Settings section shows Session Name, Save, and Load controls below Spawn Dir.
- Save writes `sessions/<sanitized_session_name>_session.json`.
- Load replaces the current tab contents with the saved layout while keeping a single root agent.
- The toolbar dropdown lists saved configurations and opens the chosen one in a newly created tab.
- Layout, minimized tiles, browser pages, work cards, connections, and port settings restore correctly.

## Phase 0
### Objective
Lock the backend schema and saved-session UX contract with failing tests.

### Red
- Add failing backend tests for config-name sanitization and save/load round-tripping a mixed session model.
- Add failing frontend/integration tests for the Settings save/load controls and the toolbar dropdown.

### Expected Failure Signal
- Missing commands, missing `sessions/` files, absent UI controls, or load operations that do not recreate the saved tab shape.

### Green
- Confirm the new tests fail for the missing session configuration functionality before implementation.

### Verification Commands
- `cargo test --manifest-path src-tauri/Cargo.toml session_config`
- `npm run test:integration -- tests/integration/test-driver.test.ts -t "saved session configuration"`

### Exit Criteria
- The added tests fail specifically because saved session configurations do not exist yet.

## Phase 1
### Objective
Implement backend save/list/load support with root reuse and mixed-tile restore behavior.

### Red
- Re-run the new backend tests after adding the config types and command scaffolding.

### Expected Failure Signal
- Serialization mismatches, bad file names, missing restore data, or root/session replacement failures.

### Green
- Add saved-session JSON types and helpers under `sessions/`.
- Implement `list_saved_session_configurations`, `save_session_configuration`, and `load_session_configuration`.
- Reuse the current session root tile during load and rebuild the remaining tiles, work cards, connections, and port settings.

### Verification Commands
- `cargo test --manifest-path src-tauri/Cargo.toml session_config`
- `cargo check --manifest-path src-tauri/Cargo.toml`

### Exit Criteria
- The backend can save and load mixed session configurations correctly in targeted tests.

## Phase 2
### Objective
Wire the frontend controls and verify end-to-end save/load behavior.

### Red
- Re-run the focused frontend/integration tests against the first UI pass.

### Expected Failure Signal
- Missing toolbar dropdown, missing Session Name/Save/Load controls, or live tabs not reflecting loaded configs.

### Green
- Add frontend wrappers for list/save/load.
- Add the toolbar dropdown beside `+`.
- Add Session Name, Save, and Load controls in Settings.
- Refresh frontend state and fit the canvas after config loads.

### Verification Commands
- `npm run check`
- `npm run test:integration -- tests/integration/test-driver.test.ts -t "saved session configuration"`

### Exit Criteria
- The UI can save the current tab, replace the current tab from a saved config, and open a saved config into a new tab.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: loaded the phased PRD workflow.
2. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: pass
   - notes: loaded the PRD template before drafting this document.
3. `cargo check --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: verified the backend save/load implementation and follow-up loader fixes compile cleanly.
4. `cargo test --manifest-path src-tauri/Cargo.toml session_config::tests -- --nocapture`
   - result: pass
   - notes: verified saved-session filename and summary helpers.
5. `npm run check`
   - result: pass
   - notes: verified the frontend/store/toolbar/sidebar changes type-check cleanly.
6. `npm run test:integration -- tests/integration/test-driver.test.ts -t "saves and loads session configurations"`
   - result: pass
   - notes: verified save, load-into-current-tab, and open-from-toolbar flows end to end.
7. `git diff --check -- src-tauri/src/session_config.rs src/lib/stores/appState.ts src/lib/Toolbar.svelte src/lib/Sidebar.svelte src/lib/tauri.ts src/lib/types.ts tests/integration/test-driver.test.ts prd/2026_03_26_saved_session_config_prd.md src-tauri/src/commands.rs src-tauri/src/network.rs src-tauri/src/work.rs src-tauri/src/lib.rs`
   - result: pass
   - notes: verified the feature diff is whitespace-clean.
