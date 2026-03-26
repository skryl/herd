# Texas Hold'em Table UI Refresh

## Status
Completed

## Date
2026-03-25

## Context
The shared-view Texas Hold'em extension already exposes the game state and browser extension API needed for multiplayer play, but the public page still renders as a generic panel/grid layout. The requested change is a more intentional poker presentation: a real table surface, four fixed chairs, richer table telemetry, and card rendering that looks like card faces instead of plain text labels. The API remains available to Herd, but it should not be presented in the browser UI.

## Goals
- Replace the generic Hold'em browser page with a poker-table presentation centered around one oval table and four fixed seats.
- Keep all relevant public game information visible without exposing the extension API in the page chrome.
- Render public cards as card faces with suit/rank presentation and hidden cards as card backs.
- Preserve the existing extension API contract and the selectors/information used by existing integration coverage where practical.

## Non-goals
- Changing the Texas Hold'em game rules or extension method signatures.
- Adding a player input UI for seat claims or actions inside the browser page.
- Keeping the current generic layout alive as a fallback path.

## Scope
- `extensions/browser/texas-holdem/index.html`
- `extensions/browser/texas-holdem/app.js`
- `extensions/browser/texas-holdem/styles.css`
- `extensions/browser/texas-holdem/texas-holdem.test.ts`
- PRD/status updates for the redesign

## Risks And Mitigations
- Existing integration tests depend on current selectors like `#status`, `.seat-name`, `.seat-stack`, and `#board .card`.
  - Mitigation: preserve those selectors while changing the page structure and visuals underneath them.
- A heavy visual rewrite could leave dead markup or duplicate rendering paths.
  - Mitigation: replace the old layout outright and remove the API panel/renderer in the same change.
- Card-face markup could accidentally expose private hole cards during active play.
  - Mitigation: only render face cards from `visible_cards` or board cards, and keep unrevealed private cards as backs.

## Acceptance Criteria
- The Hold'em page presents a poker-table UI with four fixed seats positioned around the table.
- The page keeps public telemetry visible, including status, pot, blinds, turn, and commentary.
- Community and revealed showdown cards render as structured card faces rather than plain text labels.
- Hidden hole cards remain card backs and private cards are still not leaked during active play.
- The extension methods remain available through `window.HerdBrowserExtension` but are no longer listed in the page UI.

## Phase 0
### Objective
Define the target public page structure with focused browser-page coverage.

### Red
- Add a browser-page test that expects:
  - four fixed seat nodes for north/east/south/west
  - a table stage/seat layout rather than the old API panel
  - card-face markup on public community cards after a flop is dealt
  - no visible API methods panel in the page

### Expected Failure Signal
- The current page renders the old panel/grid shell, includes the API methods list, and community cards are plain text nodes rather than structured card faces.

### Green
- Update the page layout, DOM rendering, and card helpers until the page test passes.

### Verification Commands
- `npm run test:unit -- --run extensions/browser/texas-holdem/texas-holdem.test.ts`

### Exit Criteria
- Focused page coverage passes and proves the new public layout/card rendering contract.

## Phase 1
### Objective
Ship the final poker-table presentation without regressing the shared-view extension flow.

### Red
- Re-run the existing shared-view integration after the markup rewrite and capture any selector regressions.

### Expected Failure Signal
- Shared-view Hold'em integration breaks because expected public text/selectors no longer exist or private cards leak into the DOM.

### Green
- Preserve the stable selectors and refine the UI until the existing shared-view integration passes again.

### Verification Commands
- `npm run test:integration -- tests/integration/browser-games.test.ts -t "runs a shared-view texas holdem match through one browser tile and turn-taking extension calls"`
- `npm run check`

### Exit Criteria
- The redesigned page is live, focused unit/browser coverage is green, and the shared-view integration still passes.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: loaded the required phased PRD workflow.
2. `sed -n '1,260p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: pass
   - notes: loaded the PRD skeleton and red/green checklist.
3. `sed -n '1,240p' extensions/browser/texas-holdem/index.html`
   - result: pass
   - notes: confirmed the current generic layout and API methods panel.
4. `sed -n '1,320p' extensions/browser/texas-holdem/app.js`
   - result: pass
   - notes: confirmed the current plain-text card rendering and seat grid renderer.
5. `sed -n '1,360p' extensions/browser/texas-holdem/styles.css`
   - result: pass
   - notes: confirmed the current generic green panel styling.
6. `sed -n '1,260p' extensions/browser/texas-holdem/texas-holdem.test.ts`
   - result: pass
   - notes: confirmed coverage currently stops at logic and does not lock the new UI.
7. `npm run test:unit -- --run extensions/browser/texas-holdem/texas-holdem.test.ts`
   - result: fail
   - notes: red phase confirmed the old page does not render `.table-stage` and still exposes the generic pre-refresh layout.
8. `npm run test:unit -- --run extensions/browser/texas-holdem/texas-holdem.test.ts`
   - result: pass
   - notes: focused logic plus browser-page coverage passed after the table/chair/card-face redesign landed.
9. `npm run test:integration -- tests/integration/browser-games.test.ts -t "runs a shared-view texas holdem match through one browser tile and turn-taking extension calls"`
   - result: pass
   - notes: existing shared-view browser-tile flow still passes with the redesigned page and preserved selectors.
10. `npm run check`
    - result: fail
    - notes: blocked by unrelated existing type errors in `src/lib/tilePorts.test.ts` and `src/lib/stores/appState.test.ts`, not by the Hold'em extension changes.
11. `git diff --check -- extensions/browser/texas-holdem/index.html extensions/browser/texas-holdem/app.js extensions/browser/texas-holdem/styles.css extensions/browser/texas-holdem/texas-holdem.test.ts prd/2026_03_25_texas_holdem_table_ui_prd.md`
    - result: pass
    - notes: confirmed the refreshed Hold'em files and PRD are free of whitespace/patch formatting issues.
