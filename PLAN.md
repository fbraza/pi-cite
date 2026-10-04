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

Status: complete

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

Status: complete

Implemented:
- Added `src/output-schemas.ts` with reusable paper/provider schemas, all four tool output schemas, and derived public result types. Existing paper and Europe PMC type import paths remain available.
- Added schema-aware final result construction: JSON-normalize optional undefined fields, validate the final output, and return typed `structuredContent` alongside unchanged model text and UI details.
- PubMed and Zotero structured outputs include required query metadata; provider functions and their existing details remain unchanged. Totals remain optional where the existing provider implementation omits them.
- Literature structured output contains papers, count, and provider outcomes; display previews and event histories remain only in details.
- Europe PMC uses the full-text/unavailable discriminated union, retaining provenance, excerpts, truncation, and fallback information. Expected unavailability is not an error.
- Added fixture/schema tests and a real isolated Pi session + QuickJS codemode integration test, with mocked provider HTTP and synthetic issuing assistant history (no live model request or credentials required).
- Documented the codemode return-shape change and usage in README.

Validation:
- `npm test`: all 39 tests passed (29 existing plus 10 new).
- Coverage includes minimal/complete records, empty and identifier-only searches, query filters, optional fields, ownership flags and failed ownership checks, all six Europe PMC unavailable reasons, excerpts/provenance/truncation, malformed totals, and operational failures.
- Real codemode coverage confirms structured objects from all four tools, discoverable output declarations, unavailable fallback data, failure rejection, and no nested transcript entries.
- `npm run typecheck`: passed.
- `npm run pack:check`: passed; 23 packaged files, including the new schema module and excluding tests/development files.
- `git diff --check`: passed.

Intentional changes and remaining scope:
- Codemode callers now receive objects, not JSON strings; search callers access `result.papers` instead of parsing a text array.
- Invalid final data (for example malformed provider totals) now throws an output-contract error instead of returning invalid structured data.
- Model-facing text, progress updates, UI details, provider request behavior, and tool exposure are otherwise unchanged.
- Automatic exposure, new rendering behavior, model-facing output budgets, broader integration coverage, and the release version bump remain in their later phases. Nothing has been published.

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

Status: complete

Implemented:
- Added shared `literature` namespace metadata and accurate read-only/non-destructive/idempotent/open-world annotations to all four tool factories. Shortened tool descriptions; longer workflow guidance is discoverable through `describeNamespace("literature")` rather than inlined.
- Added `src/exposure.ts`: register default-inactive tools before binding, then use the active codemode tool to choose automatic codemode/direct exposure. Explicitly selected tools remain active/direct, subject to Pi's global codemode request projection.
- Reconcile on session start/tree changes and before the next agent run, never from a loadout hook or during a provider/tool operation. Re-register only when exposure actually changes; preserve unrelated active names and ordering.
- Persist observed per-tool preferences in versioned, validated, branch-local `pi-cite-exposure` entries excluded from model context. Capture late selections on session shutdown/reload without changing the loadout during shutdown.
- Respect Pi's filtered registry for CLI/SDK allowlists and exclusions, plus named defaultTools modifiers. Disabled tools stay inactive/direct, preventing codemode callability while permitting explicit later reactivation.
- Updated README with automatic routing, selection semantics, migration behavior, and namespace discovery.

Validation:
- `npm test`: all 59 tests passed (39 previous plus 20 new exposure tests).
- Unit coverage checks pre-bind API safety, idempotence, setting modifiers, manual choices, branch reconstruction, and conservative upgrade behavior.
- Real isolated Pi sessions cover absent/inactive/active codemode, on/only modes and actual request projection, filtered allowlists/exclusions/no-tools, negative modifiers, activation changes, reload/resume, and unchanged settings after a manual disable. HTTP access is denied in these exposure tests.
- The real QuickJS codemode test now uses automatic exposure (no explicit literature activation), executes all four tools, and reads namespace instructions through discovery.
- `npm run typecheck`: passed.
- `npm run pack:check`: passed; 25 packaged files, excluding tests/development files.
- `git diff --check`: passed.

Policy details and limitations:
- Pi does not expose selection provenance. Existing active literature tools at the first upgrade/reload are conservatively treated as explicit selections. Start a fresh Pi session without explicitly naming literature tools for automatic defaults.
- A removal from the active set cannot signal a new disable when an automatic codemode tool was already inactive. Use a negative defaultTools modifier or registry exclusion to disable that tool's script access explicitly.
- Removing a settings override does not erase a recorded per-tool choice; an unchanged positive override does not repeatedly undo an observed manual disable.
- Runtime routing changes take effect at the next reconciliation boundary. No global codemode mode/settings are changed and no codemode tool is activated by this extension.
- Tool outputs, provider behavior, and rendering remain unchanged. No publication or package version bump was performed.

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

Status: complete — committed and pushed as ff48d55

Implemented:
- Forward renderer context from all four factories. Honor context-only `isError` (Pi's interactive path) and result error flags (including HTML); failed calls never receive generated success markers, even with partial or stale success details.
- Use call arguments for missing query/identifier display metadata. Show missing final display details neutrally instead of fabricating empty successful results. Preserve nonfatal Zotero ownership warnings alongside successful PubMed results.
- Add Europe PMC partial, compact, and expanded result rendering. Expected unavailability remains normal data with its exact reason and an explicit abstract fallback that was not fetched.
- Full-text views retain citation identifiers, API/source provenance, available licensing, missing sections, section fallback, aggregate/per-section truncation, and bounded excerpt previews. UI preview omissions are labeled separately from returned-excerpt truncation.
- Replace string-length table calculations with Pi TUI column/grapheme helpers. Narrow provider tables stack identifiers; PMCID and Zotero-key-only records now have usable display identifiers.
- Reuse only extension-owned result components through `lastComponent`, cache layouts by width, and regenerate themed output on invalidation. No global renderer resolver or provider/UI coupling was added.
- Update README with presentation behavior and limits.

Validation:
- `npm test`: all 76 tests passed (59 previous plus 17 new rendering tests).
- Unit coverage includes success, context/result errors, partial events, empty/missing details, all six unavailable reasons, ownership warnings, truncation/fallback/provenance, Unicode/combining/emoji widths down to one column, resizing, component reuse, and theme invalidation.
- Actual Pi `ToolExecutionComponent` coverage confirms context-only error propagation, expansion, narrow rendering, and dark/light theme invalidation without running a live terminal.
- Real isolated Pi HTML export pre-renders all four tools' failures plus Europe PMC full-text/unavailable results; checks argument fallback, warnings, provenance, and HTML escaping.
- Real isolated Pi direct/headless execution smoke-tests all four tools and confirms unchanged structured evidence/progress without invoking renderers. Provider HTTP is mocked; no model requests or live credentials are required.
- `npm run typecheck`: passed.
- `npm run pack:check`: passed; 25 packaged files, excluding tests/development files.
- `git diff --check`: passed.

Scope and remaining risks:
- Only UI rendering changed. Tool content, structured output contracts, emitted progress payloads, provider behavior, and automatic exposure remain unchanged.
- Interactive components and generated HTML are exercised automatically; no manual live-terminal or browser session was performed.
- Model-facing output budgets and retrieval artifacts remain in Phase 5. No version bump or publication was performed.

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

## Pre-Phase-5 cleanup — approved review recommendations

Status: complete — included in ff48d55

Implemented:
- Fix `sleep()` to remove its abort listener after normal completion and cancellation, clear the timer on cancellation, and avoid scheduling/attaching anything for a pre-aborted signal. Preserve the existing `Error("Request aborted")` rejection contract.
- Add five deterministic timer/listener regression tests, including repeated sleeps on one signal, preservation of unrelated listeners, pending cancellation, pre-aborted signals, and abort after completion.
- Document exposure precedence and replace positional reset/restoration flags with named options. Keep the existing state schema, explicit fresh-state object, algorithm order, persistence, and lifecycle boundaries unchanged; no new state-machine abstraction.
- Add a regression test showing that removing positive/negative settings overrides does not reset recorded preferences, while explicit later activation can re-enable a tool.
- Remove the four unused `register*Tool` wrappers and their now-unused ExtensionAPI imports. Repository searches found no remaining callers, and documentation history/package metadata show no supported standalone API for these helpers. Pi's declared entry is `src/index.ts`.
- Retain the tool factories and tool names. Since source files are shipped and undocumented deep imports were technically possible, note the removal/migration caveat in CHANGELOG.md; external usage cannot be ruled out.
- Keep README focused on installation and usage. Move change history, implementation details, and migration notes to CHANGELOG.md, included in the npm package.

Validation:
- `npm test`: all 82 tests passed (76 previous plus five sleep tests and one exposure-precedence test).
- `npm run typecheck`: passed.
- `npm run pack:check`: passed; 26 packaged files, including CHANGELOG.md and excluding tests/development files.
- `git diff --check`: passed.

Scope:
- No provider rewrite, new configuration API, dependency, formatter, test harness, or renderer abstraction.
- Included these changes with Phase 4 in ff48d55. No version bump or publication was performed.
- Phase 5 had not begun at this checkpoint.

## Phase 5 — Bounded evidence and codemode workflow

Status: complete — committed and pushed as a1053d4

Implemented:
- Add `src/evidence-output.ts` and use it for all four final tool results. Validate complete structured data before any artifact write; retain the existing output schemas, complete structured objects, and UI evidence.
- Bound successful final model content to 32 KiB measured in UTF-8, including provider warnings/retrieval instructions. Small primary evidence text is unchanged; nonfatal literature provider outcomes also reach the model in a separate warning text block.
- Large results contain valid JSON evidence previews with aggregate/individual truncation distinctions, original/full-result byte counts, total/shown record counts, and an actual complete JSON path. Prose is labeled `abstract_excerpt`/`text_excerpt`; descriptive metadata/arrays may be shortened. Citation IDs, URLs, licenses, and warnings are retained verbatim up to 1024 serialized bytes per field or explicitly omitted, never rendered as plausible shortened identifiers/provenance.
- Write complete normalized structured results (not UI histories) to unique OS-temporary `pi-cite-evidence-*` directories. POSIX directory/file permissions are 0700/0600. Remove directories after failed/cancelled writes or preview-construction failure. Successful artifacts deliberately survive shutdown/reload for transcript retrieval; users must copy them into review folders for durable retention.
- Render model-preview truncation notes and expanded artifact paths separately from retrieval-excerpt truncation and UI-preview omissions.
- Add `src/request-gate.ts`: one FIFO lane per provider, held through body consumption. Shared NCBI pacing covers ESearch, EFetch, and identifier lookup (350 ms without a key, 120 ms with one; mixed intervals are conservative). Honor NCBI/Europe PMC Retry-After seconds/HTTP dates and the longest Zotero Backoff/Retry-After. Preserve failure outcomes and add no retries.
- Queue/backoff waits are abortable, cancelled waiters release only their own slot, and fetches receive the signal. Re-throw ownership-check cancellation instead of presenting a successful unchecked literature search. Remove redundant per-call PubMed sleeps now covered by shared pacing.
- Add `references/codemode-workflows.md`, linked from the bundled skill: two-call batches with Promise.allSettled, multi-identifier deduplication (including bridging records), source/ownership preservation, complete result saves through write, small evidence projections, and opt-in selective full text. Clarify repeated ownership scans and small-state-only codemode storage.
- Keep README usage-focused; put operational/migration detail in CHANGELOG.md and skill references. No dependencies, schema additions, new tools, settings changes, or model requests were introduced.

Validation:
- `npm test`: all 111 tests passed (82 previous plus 29 new Phase 5 tests).
- Output tests cover all result schemas, exact UTF-8 boundaries, emoji/CJK and JSON escaping, huge metadata and single records, identifiers/warnings, complete artifacts and unchanged structured data, private/unique paths, explicit retention/deletion, invalid data, write failures, cancellation, and preview-failure cleanup.
- Gate/provider tests cover FIFO body-consumption concurrency, differing intervals, shared backoff, failure recovery, queued/backoff/pre-aborted/in-flight cancellation, listener cleanup, real PubMed/Zotero/Europe PMC call paths, and ownership cancellation propagation with HTTP mocked.
- Real isolated Pi direct/QuickJS integration exercises all four large tools, verifies the byte budget and complete structured/JSON evidence, retrieves an artifact using Pi's actual read tool, saves complete nested evidence through write, retains success alongside a failure via Promise.allSettled, and confirms artifact survival after session disposal. No live model/provider requests or credentials are required.
- Execute both bundled workflow examples with deterministic tool doubles, checking two-call concurrency, bridging-ID deduplication, source/ownership preservation, failure retention, small storage, and unavailable full-text data without automatic fallback retrieval.
- Existing Python extraction/table/export compatibility tests and renderer/HTML/session suites pass. New renderer coverage distinguishes artifact/model truncation from excerpt truncation.
- `npm run typecheck`: passed.
- `npm run pack:check`: passed; 29 packaged files, including two new source modules and the skill reference, excluding tests/development files.
- `git diff --check`: passed.

Intentional changes and remaining risks:
- Successful oversized calls now have a local filesystem side effect, including nested codemode calls whose structured data stays complete. Zotero access itself remains read-only; artifacts can contain private library metadata. Disk errors reject the result rather than silently losing retrievable evidence.
- Successful temp files are not automatically removed by this extension and can accumulate. Their availability after OS cleanup is not guaranteed; copy desired evidence, and explicitly delete scratch directories when no longer needed. Abrupt process termination cannot guarantee failure cleanup.
- Scheduling is per loaded module instance, not cross-process or durable across reloads. It bounds provider HTTP concurrency, not total queued call count. Large scans/long backoff can outlast a codemode deadline; examples limit submission to two calls at a time. No ownership cache or new request timeout policy was added.
- The byte limit applies to successful final data content, not emitted progress or Pi-generated thrown-error text. Complete structured evidence and session/UI details are not size-capped.
- Tests exercised Node.js 24 locally; the declared minimum Node version and live provider quotas were not separately tested. No manual live-terminal/browser review was performed.
- Phase 5 was committed and pushed as a1053d4. No version bump, publication, or Phase 6 work was performed in that checkpoint.

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

Status: complete — approved for commit and push; 2.0.0 remains unpublished

Implemented:
- Expand `tests/codemode.test.ts` into eight real Pi/QuickJS scenarios: all SDK-bound runtime modes (`tui`, `rpc`, `json`, `print`) with codemode `on` and `only`. Verify all four tools' complete typed results, ownership and excerpts, expected unavailable fallback, namespace/schema discovery, nested IDs/parent IDs, provider progress and parent status publication, rejected operational/permission calls, result-hook replacement, and no nested transcript entries. Provider HTTP is mocked; requests made before fixture setup are denied.
- Add `tests/codemode-cancellation.test.ts`. Abort after the actual nested HTTP operation starts (not after a guessed VM startup delay); verify signal propagation, failed/cancelled status, retained partial script output, and successful subsequent work on the shared provider lane without retries.
- Add `tests/tui-smoke.test.ts` and `tests/fixtures/tui-smoke.ts`. Drive genuine Pi `ProcessTerminal`, `ToolExecutionComponent`, and main/alternate-screen TUIs through a POSIX pseudo-terminal with keyboard input and SIGWINCH. Exercise partial/success/failure, a real complete JSON artifact, expansion, Unicode, dark/light invalidation at the same width, 120-to-32-column resizing, raw-mode restoration, and alternate-screen restoration. Scratch files/logs are isolated under the test directory and removed.
- Add `tests/package-release.test.ts`. Build an actual offline npm tarball with lifecycle scripts disabled, verify package/lock versions and exclusions, unpack safely, and load the archive's manifest-selected extension and bundled skill through Pi without bundled host dependencies. Exercise a real structured direct call with mocked HTTP. Remove the archive and unpacked resources after the test. Support npm 10/12's differing JSON result layouts.
- Reuse earlier direct/headless, large-output/artifact, exposure/reload/resume, rendering/HTML, skill-example, and Python export/extraction coverage; do not duplicate their infrastructure or add production abstractions.
- Update README with concise automatic-routing/selection guidance, a structured codemode example, and full-text return/fallback semantics. Keep migration/implementation history in CHANGELOG.md.
- Prepare `2.0.0` in package.json and package-lock.json, without creating a tag or publishing. A major release is appropriate for string-to-object codemode returns, Pi v1/Node runtime requirements, removed undocumented wrappers, and large direct-text presentation changes. Mark the changelog explicitly unreleased.
- Production source, provider evidence contracts, dependencies, tool names, default exposure behavior, and settings are unchanged in Phase 6.

Validation:
- `npm test`: all 122 tests passed on Node.js 24.15.0/npm 12.2.0 and Node.js 22.22.2/npm 10.9.7 (111 previous, plus seven matrix scenarios, one cancellation test, one archive test, and two terminal smoke tests).
- `npm run typecheck`: passed on both Node versions.
- `npm run pack:check`: passed; 29 packaged files, excluding tests/fixtures, development files, and host node_modules. The actual-archive test also passed with both npm layouts.
- Installed local Pi CLI reports `1.0.1`; tests use that pinned Pi/TUI baseline.
- `git diff --check`: passed.
- Test fixture issues (theme initialization before constructing the interactive component, waiting for the actual resize event rather than racing SIGWINCH, and npm 12's keyed pack JSON) were corrected; no production changes were needed.

Final diff review and known limitations:
- Only tests, README/CHANGELOG/PLAN, and the synchronized release version changed in this phase. No new runtime dependencies, model calls, provider rewrites, compatibility layer for old Pi, formatter/framework migration, or automatic publication.
- Mode tests use SDK-bound modes with synthetic authoritative assistant history; they do not exercise the entire CLI/editor or RPC transport. Terminal smoke tests use real PTYs/TUI components and fixture keys, not a manual live model session or human visual inspection. Existing HTML tests assert generated renderer output; no manual browser review was performed.
- PTY tests are skipped on Windows; Windows terminal behavior was not tested locally. Tests require python3 and npm for scripts/archive/smoke checks. Exact Node.js 22.19.0 was not exercised; Node 22.22.2 and 24.15.0 both passed.
- Live provider quotas, changing scientific content, and model authentication/network timeouts are not covered by mocked tests. The previously reported OAuth refresh timeout remains a separate, unresolved environment diagnostic.
- Phase 5 retention/privacy/scheduling limits still apply: successful private temp artifacts can accumulate or disappear after OS cleanup, and provider lanes are local to loaded modules rather than cross-process. Complete structured evidence remains uncapped; large scans/server backoff can outlast script deadlines.
- Phase 6 was approved for commit and push. No tag, publication, or further phase work was performed. Release tagging/publication require separate approval.

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
