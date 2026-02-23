# LLM Split Refactor PRD

## Status

Completed (2026-02-23)

## Context

`src/llm.rs` currently mixes:

1. Provider dispatch/public API.
2. HTTP request/response flows for OpenAI and Anthropic.
3. JSON parsing helpers and fixture model-list handling.

This coupling makes provider-specific updates riskier and less testable in isolation.

## Goals

1. Split provider HTTP logic and parsing helpers into dedicated submodules.
2. Keep existing `llm` public APIs and behavior unchanged.
3. Preserve existing tests and fixture behavior.

## Non-goals

1. No API endpoint changes or new providers.
2. No semantic changes to rule evaluation payloads.
3. No changes to config/provider normalization behavior.

## Phased Plan (Red/Green)

### Phase 1: Baseline and extraction map

Red:
1. Run llm-focused tests and baseline behavior.
2. Freeze extraction boundaries for provider HTTP vs parsing helpers.

Green:
1. Confirm stable external function list.

Refactor:
1. Preserve function signatures used by call sites/tests.

Exit criteria:
1. Baseline tests are green and boundaries are clear.

### Phase 2: Extract parsing helper module

Red:
1. Move parser helpers incrementally and compile.

Green:
1. Add `src/llm/parsing.rs`.
2. Move model-id/chat-content parsing and env fixture helper.
3. Re-export needed helpers inside `llm` for unchanged call sites/tests.

Refactor:
1. Keep parsing helpers provider-agnostic.

Exit criteria:
1. Parser logic no longer implemented directly in `src/llm.rs`.

### Phase 3: Extract provider HTTP module

Red:
1. Move provider HTTP functions incrementally and compile.

Green:
1. Add `src/llm/provider_http.rs`.
2. Move OpenAI/Anthropic fetch/eval HTTP flows.
3. Keep `fetch_models`/`evaluate_rule` dispatch in `src/llm.rs`.

Refactor:
1. Keep error messages stable.

Exit criteria:
1. `src/llm.rs` focuses on API dispatch and module wiring.

### Phase 4: Validation and completion

Red:
1. Run targeted and broad regression gates.

Green:
1. Fix regressions and rerun until green.

Refactor:
1. Final import cleanup and formatting.

Exit criteria:
1. `cargo test --lib` passes.
2. `cargo test --tests` passes.
3. `./scripts/run-integration-tests.sh --tier fast` passes.
4. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: baseline captured and boundaries frozen.
2. Phase 2: parser helpers extracted and wired.
3. Phase 3: provider HTTP helpers extracted and wired.
4. Phase 4: all required gates green and PRD finalized.

## Acceptance Criteria

1. New `src/llm/parsing.rs` and `src/llm/provider_http.rs` exist and are wired.
2. Existing `llm` public APIs behave unchanged.
3. Full test and integration gates are green.
4. PRD status/checklist reflects completion.

## Risks and Mitigations

1. Risk: subtle error-message drift.
   Mitigation: move bodies with minimal edits and rerun tests.
2. Risk: parsing helper visibility errors.
   Mitigation: use explicit `pub(super)`/re-export wiring.
3. Risk: provider dispatch regressions.
   Mitigation: preserve top-level match routing and run full integration tiers.

## Implementation Checklist

- [x] Phase 1 baseline captured
- [x] Phase 2 `parsing.rs` extracted and wired
- [x] Phase 3 `provider_http.rs` extracted and wired
- [x] Phase 4 `cargo test --lib` green
- [x] Phase 4 `cargo test --tests` green
- [x] Phase 4 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 4 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
