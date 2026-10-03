# @fbraza/pi-cite

A Pi extension and bundled skill for literature research. It searches PubMed and Zotero, retrieves open-access article sections from Europe PMC, and helps turn evidence into structured reviews.

## Install

Requires Pi **1.0.1 or later within v1** and Node.js **22.19.0 or later**. Pi supplies the host packages and TypeBox at runtime; they are not bundled by this extension.

Install for Pi with:

```bash
pi install npm:@fbraza/pi-cite
```

Or load it for one session without changing your settings:

```bash
pi -e npm:@fbraza/pi-cite
```

Set `NCBI_API_KEY` for PubMed rate limits. Set `ZOTERO_API_KEY` to search your Zotero library and flag PubMed results you already own; Zotero access is read-only.

## Features

- **PubMed search** with MeSH, title/abstract, publication-type, and Boolean queries.
- **Zotero search** by title, creator, year, or indexed full text.
- **Europe PMC full text** for open-access articles, addressed by DOI, PMID, or PMCID. Returns structured section excerpts with licensing, source, and truncation details.
- **Literature skill** for focused searches, citation verification, experiment extraction, and evidence-based synthesis. Full-text use is opt-in.

## Example

After installing, ask Pi:

> Find recent preclinical studies of NLRP3 inhibition in Alzheimer’s disease. Search PubMed, check which papers are in my Zotero library, and retrieve Europe PMC sections for the most relevant open-access papers.

The extension provides `literature_search`, `pubmed_search`, `zotero_search`, and `europe_pmc_fulltext` tools for this workflow.

## Structured tool results

All four tools declare an output schema. Codemode calls now return **objects**, not JSON strings; do not use `JSON.parse()` on their results:

| Tool | Codemode result |
|---|---|
| `pubmed_search` | `{ count, papers, query, total? }`; `query` includes applied filters |
| `zotero_search` | `{ count, papers, query, total? }` |
| `literature_search` | `{ count, papers, providers }`; provider outcomes include search/ownership status and failure reasons |
| `europe_pmc_fulltext` | A `status: "full_text"` or `status: "unavailable"` object, with provenance and excerpt/fallback data |

`count` is the number of returned papers; `total` is optional and included where the provider implementation exposes it. Missing optional fields are omitted from structured output. Literature display events and previews remain in UI `details`, not in the public data object. A Zotero provider's `count` refers to scanned library items, not matched candidate papers.

For example, with codemode enabled:

```js
const result = await tools.pubmed_search({ query: "systematic review[pt]", max_results: 5 });
text(result.papers.map(({ pmid, doi, title }) => ({ pmid, doi, title })));
```

Direct calls retain the existing model-facing JSON text: search tools return the paper array as text, and Europe PMC returns its full result object as text. Progress updates are unchanged. Expected full-text unavailability is a normal result with `recommended_fallback: "pubmed_abstract"`; operational failures reject. Final structured outputs are schema-validated before returning.

## Development

```bash
npm ci
npm test
npm run typecheck
npm run pack:check
```

Development is pinned to Pi and Pi TUI **1.0.1**, with TypeBox **1.3.27** to match that host. Type checking covers `src/` and `tests/` without generating build files. The test suite also requires `python3` for the bundled literature scripts.
