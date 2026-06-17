# pi-extension-literature-tools

A standalone [Pi](https://pi.dev) extension providing literature-research tools for
academic workflows. Registers four tools callable by the agent:

- **`literature_search`** — PubMed-first search with optional Semantic Scholar
  supplementary metadata.
- **`pubmed_search`** — direct PubMed query (MeSH, `[tiab]`, `[pt]`, etc.).
- **`fetch_fulltext`** — retrieve a paper PDF via PMC → publisher OA → fallback.
- (`semantic_scholar` helper used internally by the search tools.)

## Install

```bash
# install into your user pi settings
pi install ~/Documents/pi-extension-literature-tools

# or try it for the current run only
pi -e ~/Documents/pi-extension-literature-tools
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
