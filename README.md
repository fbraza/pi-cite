# @fbraza/pi-cite

A standalone [Pi](https://pi.dev) extension providing literature-research tools for
academic workflows. Registers four tools callable by the agent:

- **`literature_search`** — PubMed-first search with optional Semantic Scholar
  supplementary metadata.
- **`pubmed_search`** — direct PubMed query (MeSH, `[tiab]`, `[pt]`, etc.).
- **`fetch_fulltext`** — retrieve a paper PDF via PMC → publisher OA → fallback.
- (`semantic_scholar` helper used internally by the search tools.)

## Bundled skill

Ships with the **`literature`** skill (`skills/literature/`), which turns these
tools into an end-to-end review workflow: verified-citation search, full-text
retrieval, per-paper experiment extraction, and a structured hypothesis
synthesis. Its frontmatter declares `allowed-tools` covering the extension's
tools above, so the skill and extension are paired on purpose.

- `references/` — PubMed/Semantic Scholar query syntax, API reference, and
  full-text access routines.
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
| `SEMANTIC_SCHOLAR_API_KEY` | Enables Semantic Scholar supplementary search |
