# Pi v1 modernization plan

## Goal

Make pi-cite native to Pi v1: typed results for codemode, useful bounded evidence for direct calls, and compact, accurate rendering. Implement one phase at a time, review its diff and validation results, and stop before the next phase.

Reference: https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/docs/extensions.md

## Agreed behavior

- Target Pi v1; no compatibility layer for pre-v1 APIs.
- When codemode is active, expose the literature tools through codemode by default.
- When codemode is not active, expose them directly by default.
- Determine availability from Pi's runtime active tool set, not merely registration: the built-in codemode extension can be loaded while its tool is inactive.
- Do not enable codemode, change its global mode, or overwrite unrelated tool selections.
- Respect explicit user tool selections; automatic defaults must not repeatedly reactivate intentionally disabled tools.
- Keep existing tool names and provider semantics.
- Separate model-facing `content`, programmatic `structuredContent`, and rendering/session `details`.
- Preserve citation identifiers, ownership information, provenance, availability reasons, and truncation warnings.
- Keep full-text retrieval opt-in in the literature skill.
- No new synthesis/model calls, classifiers, or provider rewrites in this migration.

## Phase 1 — Pi v1 baseline

Status: complete — awaiting review before Phase 2

Implemented:
- Pinned Pi coding-agent and TUI development dependencies to `1.0.1` and TypeBox to the host's `1.3.27`; constrained peer ranges to compatible v1 releases.
- Declared Node.js `>=22.19.0`, matching Pi's minimum, and synchronized the existing lockfile with the current package identity and dependencies.
- Added TypeScript `5.9.3`, Node typings, and a strict no-emit check covering source and tests. Dependency declaration internals are excluded with `skipLibCheck`.
- Fixed existing typing issues without changing tool behavior: use exported Pi theme/render option types, accurately narrow `unique()`'s non-null return type, and assert the optional Zotero provider exists in its test.
- Documented requirements and development commands in README.

Validation (Node.js `24.15.0`, npm `12.2.0`):
- Clean `npm ci`: passed; audit reported zero vulnerabilities.
- Local Pi CLI `--version`: `1.0.1`.
- `npm test`: all 29 existing tests passed.
- `npm run typecheck`: passed.
- `npm run pack:check`: passed; 22 packaged files, no bundled host dependencies or development-only files.
- `git diff --check`: passed.

Notes:
- npm warned about deprecated transitive `node-domexception` and blocked install scripts for `esbuild`, `@google/genai`, and `protobufjs`. No script approvals or npm security policy changes were made. These warnings did not block baseline checks; exercise relevant runtime paths in later integration coverage.
- Only Node.js 24 was exercised locally; the declared Node.js minimum comes from Pi's supported engine range.
- Tool content, exposure, provider behavior, and renderer output are unchanged. No publication or package-version bump was performed.

Work:
- Update coding-agent and TUI development dependencies to a tested v1 baseline (initially v1.0.1).
- Declare supported v1 peer ranges and verify TypeBox compatibility.
- Install dependencies and establish the existing test baseline.
- Add a TypeScript checking command/configuration if needed, using Pi's exported contracts rather than permissive local substitutes where practical.

Acceptance:
- Existing tests pass, or pre-existing failures are documented separately.
- Type checking and `npm run pack:check` succeed.
- No tool output or exposure behavior changes in this phase.

## Phase 2 — Structured output contracts

Status: pending

Work:
- Define reusable TypeBox paper and result schemas; derive public result types where practical to avoid schema/type drift.
- Add `outputSchema` to all four tools and matching `structuredContent` on every successful result path.
- Extend result helpers in `src/tool-output.ts`; keep progress updates separate from final result requirements.
- Search outputs expose paper records and relevant query/count/total/provider metadata, without UI event histories or duplicate display records.
- Europe PMC exposes a discriminated full-text/unavailable union with provenance and fallback information.
- Preserve existing model-facing content initially, isolating this contract change from truncation changes.
- Keep thrown operational failures as failures; expected full-text unavailability remains a normal data result.

Acceptance:
- Validate real fixture outputs against schemas, including empty searches, optional fields, ownership-check failures, and all unavailable variants.
- Test successful structured results and unchanged progress updates.
- Test Pi/codemode returns an object rather than a JSON string.
- Document any intentional public return-shape changes.

## Phase 3 — Automatic exposure and tool metadata

Status: pending

Work:
- Group the four tools in a shared `literature` namespace with short descriptions and discoverable instructions.
- Add accurate read-only, non-destructive, idempotent, open-world annotations.
- Implement automatic codemode/direct defaults using supported Pi lifecycle/loadout APIs.
- Verify initialization order before selecting exposure; do not query session-only APIs from an unbound factory.
- Handle startup, reload, and resume. Define and test changes to codemode activation during a session at a safe runtime boundary without creating selection loops.
- Preserve explicit selections and unrelated tools. Explicit activation of a literature tool remains supported even in codemode mode.

Acceptance:
- Test codemode active, registered-but-inactive, and unavailable/disabled.
- Verify codemode `on` and `only` modes, namespace discovery, and activation changes.
- Verify direct-only sessions, reload/resume, and explicit tool exclusions.
- No duplicate registrations, global settings changes, or repeated unnecessary loadout updates.

## Phase 4 — Rendering correctness and consistency

Status: pending

Work:
- Use Pi's renderer context, particularly `isError` and `args`.
- Never show a success checkmark for failed calls.
- Show queries from call arguments where result details lack them.
- Add a compact/expanded/partial renderer for Europe PMC, including unavailable reasons and truncation/provenance information.
- Retain existing per-tool renderers; no global renderer resolver is needed for tools owned by this extension.
- Use terminal-column-aware width helpers for tabular formatting; reuse `lastComponent` where safe and worthwhile.
- Keep renderers independent from provider execution and functional without terminal UI.

Acceptance:
- Tests cover success, error, partial, empty, unavailable, and truncated states.
- Test narrow widths, Unicode, expansion, and theme invalidation.
- Verify interactive rendering and HTML export; smoke-test headless execution.

## Phase 5 — Bounded evidence and codemode workflow

Status: pending

Work:
- Define an explicit model-facing output budget, including multibyte text.
- Keep the complete returned result in structured output while bounding large `content` payloads.
- For truncated model-facing results, implement a real retrieval path (for example a complete JSON artifact), with clear instructions and truncation metadata. Verify artifact behavior and cleanup before adding filesystem side effects.
- Preserve useful evidence, identifiers, provider warnings, and provenance in direct-call output; do not replace evidence with count-only summaries.
- Update the bundled literature skill with structured codemode examples: batched queries, `Promise.allSettled`, deduplication, projection, and selective full-text retrieval.
- Bound request concurrency and honor shared provider rate limits/backoff. Parallel scripts must not imply unlimited PubMed/Zotero requests or repeated expensive ownership scans.
- Use codemode storage only for small state; do not persist whole paper sets by default.

Acceptance:
- Large-result tests demonstrate bounded model content and complete structured data/retrievable artifacts.
- No fabricated provenance or silently lost evidence.
- Existing export/extraction workflows remain compatible.
- Document and test cancellation and rate-limit behavior for batched calls.

## Phase 6 — End-to-end validation and release documentation

Status: pending

Work:
- Add deterministic, mocked Pi integration coverage for direct and codemode execution.
- Verify nested-call error/progress behavior and runtime mode independence.
- Update README with the supported Pi version, automatic exposure policy, return contracts, and examples.
- Run tests, type checking, packaging checks, and interactive smoke tests.
- Choose an appropriate package version for the public contract changes; do not publish automatically.

Acceptance:
- Integration tests prove typed codemode results and useful direct-call content.
- Tests do not require live credentials or network access by default.
- Final diff and known limitations are reviewed before release.

## Working checkpoints

After each phase:
1. Summarize changed files and intentional behavior changes.
2. Report tests/checks actually run, including blockers.
3. Review remaining risks and update this plan's status.
4. Stop for review before beginning the next phase.

## Initial baseline observation

The repository was clean before this plan was added. During the preceding review, `npm test` passed the five Python-backed output tests, but both TypeScript test files failed to load because `typebox` was not installed locally. Phase 1 must establish a complete baseline before making functional changes.
