# Semantic Scholar — Routine Quick-Reference

Quick-start for paper search, paper lookup, and author search. For citation network analysis or bulk queries → consult the full API documentation.

## Paper Search

```
GET https://api.semanticscholar.org/graph/v1/paper/search
```

**Parameters:**
| Parameter | Value |
|---|---|
| `query` | Search terms |
| `limit` | Max results (default 10, max 100) |
| `offset` | Pagination offset |
| `fields` | Comma-separated fields to return |
| `year` | `<YYYY>` or `<YYYY-YYYY>` range |
| `fieldsOfStudy` | Field of study filter |

**Useful fields:** `paperId`, `title`, `abstract`, `year`, `referenceCount`, `citationCount`, `authors`, `journal`, `publicationTypes`, `tldr`, `openAccessPdf`, `externalIds`

**Example:**
```
https://api.semanticscholar.org/graph/v1/paper/search?query=CRISPR+off-target&limit=20&fields=title,abstract,year,citationCount,openAccessPdf
```

## Paper Details (by ID)

```
GET https://api.semanticscholar.org/graph/v1/paper/{paper_id}
```

`paper_id` accepts: S2 ID, DOI (`DOI:10.xxx`), PMID (`PMID:12345`), ArXiv ID.

**Example:**
```
https://api.semanticscholar.org/graph/v1/paper/DOI:10.1038/s41586-024-07000-0?fields=title,abstract,year,citationCount,references,citations
```

## Author Search

```
GET https://api.semanticscholar.org/graph/v1/author/search?query=<name>
GET https://api.semanticscholar.org/graph/v1/author/{author_id}/papers
```

## Rate Limits

100 requests / 5 min (unauthenticated). Higher limits available with an API key.
