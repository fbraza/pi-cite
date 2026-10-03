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

## Development

```bash
npm ci
npm test
npm run typecheck
npm run pack:check
```

Development is pinned to Pi and Pi TUI **1.0.1**, with TypeBox **1.3.27** to match that host. Type checking covers `src/` and `tests/` without generating build files. The test suite also requires `python3` for the bundled literature scripts.
