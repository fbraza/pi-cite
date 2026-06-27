# @fbraza/pi-cite

A standalone [Pi](https://pi.dev) extension providing literature-research tools for
academic workflows. Registers three tools callable by the agent:

- **`literature_search`** — literature workflow search against PubMed using a
  PubMed-ready query (MeSH `[mh]`, `[tiab]`, `[pt]`, substance `[nm]`, and Boolean
  logic), with streaming progress and deduplicated results. When a Zotero API key
  is configured, PubMed candidates are automatically cross-checked against your
  Zotero library and flagged with `in_zotero` (read-only — no library writes).
- **`pubmed_search`** — direct PubMed query (MeSH, `[tiab]`, `[pt]`, etc.).
- **`zotero_search`** — keyword search of your Zotero library (title/creators/year,
  and indexed full text when `qmode=everything`); returns metadata and abstracts of
  papers you already own.

## Bundled skill

Ships with the **`literature`** skill (`skills/literature/`), which turns these
tools into an end-to-end review workflow: verified-citation search, per-paper
experiment extraction, and a structured hypothesis synthesis. Its frontmatter
declares `allowed-tools` covering the extension's tools above, so the skill and
extension are paired on purpose.

- `references/` — PubMed query syntax, API reference, and common queries.
- `scripts/` — Python helpers (`extract_experiments.py`, `synthesis.py`,
  `generate_table.py`, `export_all.py`) invoked by the skill.

## Install

Published on npm as `@fbraza/pi-cite`:

```bash
# install into your user pi settings
pi install npm:@fbraza/pi-cite

# pin a specific version
pi install npm:@fbraza/pi-cite@0.1.0

# or try it for the current run only (no settings change)
pi -e npm:@fbraza/pi-cite
```

Pi provides the host packages (`@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui`, `typebox`) at runtime, so they are declared as
peer dependencies and are not bundled.

## Develop

```bash
npm install
npm test            # run the unit tests
npm run pack:check  # preview the published tarball contents
```

## Environment variables

| Variable | Purpose |
|---|---|
| `NCBI_API_KEY` / `api_key` env | PubMed rate limit + E-utilities auth |
| `ZOTERO_API_KEY` | **The only Zotero var you need to set.** Enables the `in_zotero` ownership check in `literature_search` and the `zotero_search` tool. The library user ID is auto-discovered from the key via `/keys/current`, so no ID is required for a personal library. |
| `ZOTERO_USER_ID` | Optional override for the user ID (auto-discovered otherwise). Only set if `/keys/current` does not return the expected ID. |
| `ZOTERO_LIBRARY` | `user` (default) or `group`. Set to `group` only to scan a group library instead of your personal one. |
| `ZOTERO_GROUP_ID` | Group library ID (required only when `ZOTERO_LIBRARY=group` — a key can access many groups, so there is no default). |

For the common case — a personal Zotero library — set just `ZOTERO_API_KEY` and
you're done. The ownership scan fetches top-level library items (capped at ~2000)
and matches PubMed candidates by DOI, PMID, PMCID, or title-year. All Zotero
access is read-only; no papers are ever written to your library.
