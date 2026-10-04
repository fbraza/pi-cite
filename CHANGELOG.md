# Changelog

## Unreleased

### Changed

- Target Pi v1: require Pi 1.0.1 or later within v1 and Node.js 22.19.0 or later. Development uses Pi/Pi TUI 1.0.1 and TypeBox 1.3.27; host packages are not bundled.
- All four tools declare output schemas and return validated `structuredContent`. Codemode receives objects rather than JSON strings. Model-facing text remains unchanged: search tools return paper arrays, and Europe PMC returns its result object.
- Route default literature tools through codemode when it is active, or activate them directly otherwise. Merely registering codemode does not enable this routing.
- Group tools in the `literature` namespace with read-only, non-destructive, idempotent, open-world annotations. Longer guidance is discoverable through `describeNamespace("literature")`.
- Preserve observed tool choices across reload/resume through branch-local `pi-cite-exposure` entries, outside model context. Reconcile at lifecycle boundaries without changing global codemode settings or unrelated selections.
- Add compact/expanded Europe PMC rendering for progress, excerpts, expected unavailability, provenance, licensing, missing sections, and truncation.
- Adapt search tables to terminal-column widths and Unicode. Expanded views preview five papers; full-text views preview five sections and 320 terminal columns of prose per section. These limits affect presentation only, not returned evidence.
- Document exposure precedence and replace positional reset/restoration flags with named options, without changing the algorithm.

### Fixed

- Failed tool calls honor Pi's renderer error context and no longer receive generated success checkmarks. Missing final display details no longer appear as empty successful searches.
- Expanded search views recover missing queries from call arguments. Successful PubMed searches retain warnings when Zotero ownership checks fail.
- Result components refresh correctly on invalidation and resize, and reuse only extension-owned components.
- `sleep()` removes abort listeners after completion/cancellation, clears cancelled timers, and rejects pre-aborted signals without scheduling a timer or attaching a listener. The existing `Error("Request aborted")` contract is unchanged.

### Removed

- Unused `registerPubmedSearchTool`, `registerZoteroSearchTool`, `registerLiteratureSearchTool`, and `registerEuropePmcFulltextTool` wrappers. No repository callers or documented standalone API were found. Tool factories and tool names remain unchanged.
- Consumers using undocumented deep imports of these wrappers must migrate to the Pi extension entry, `src/index.ts`. Because source files were shipped, external deep-import usage cannot be ruled out.

### Migration notes

#### Structured results

Use `result.papers` instead of `JSON.parse(result)` in codemode:

| Tool | Result |
|---|---|
| `pubmed_search` | `{ count, papers, query, total? }`; query includes applied filters |
| `zotero_search` | `{ count, papers, query, total? }` |
| `literature_search` | `{ count, papers, providers }` |
| `europe_pmc_fulltext` | `status: "full_text"` or `status: "unavailable"`, with provenance and excerpt/fallback data |

Search `count` is the number of returned papers; `total` is optional. Missing optional fields are omitted. Literature display events/previews remain in UI details, not structured output. A Zotero provider's count refers to scanned library items, not matched candidates.

Expected full-text unavailability is normal data with `recommended_fallback: "pubmed_abstract"`; it does not fetch an abstract automatically. Operational failures reject. Final structured outputs are schema-validated.

#### Automatic exposure

- Use `defaultTools: ["+codemode"]` for automatic routing. `--tools codemode` restricts the registry to codemode and does not make literature tools script-callable.
- Explicit startup/later activation remains authoritative, subject to Pi's global `codemode.mode: "only"` request projection. CLI/SDK registry allowlists and exclusions are respected.
- Already-active literature tools on the first upgrade/reload are conservatively preserved as explicit selections, because Pi does not expose selection provenance. Start a fresh session without explicitly naming literature tools for automatic defaults.
- Use a negative modifier such as `"-pubmed_search"` in `defaultTools`, or a registry exclusion, to disable an already-inactive codemode tool. Removing it from the active set alone cannot express a new disable.
- An unchanged positive override does not repeatedly undo a recorded manual disable. Removing an override does not erase recorded preferences; explicit later activation can re-enable the tool.
- Mid-session activation changes take effect before the next agent run. The extension does not enable codemode or change its global mode.

#### Rendering

UI preview omissions are labeled separately from truncation of the returned excerpts. Interactive transcripts and HTML exports use the same per-tool renderers; execution remains independent of terminal UI. Provider requests, structured evidence, and emitted progress payloads are unchanged by the rendering updates.
