# PubMed E-utilities — Routine Quick-Reference

Quick-start for routine literature searches (≤200 PMIDs, common field tags). For batch operations, history server, or all 9 endpoints → load `pubmed_api_reference.md`. For advanced search syntax → load `pubmed_search_syntax.md`. For query templates by scenario → load `pubmed_common_queries.md`.

## Core Endpoints (Routine)

| Endpoint | Purpose | When to use |
|---|---|---|
| `esearch.fcgi` | Search and retrieve PMIDs | Every PubMed search |
| `efetch.fcgi` | Download full records / abstracts | Retrieving paper details |
| `esummary.fcgi` | Get document summaries (title, authors, journal) | Quick metadata checks |

## Search (ESearch)

```
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi
```

**Parameters (routine):**
```
db=pubmed
term=<query>
retmax=<N>        # max results (default 20, max 10000 for routine queries)
retmode=json
sort=relevance    # or "pub_date", "first_author"
datetype=pdat
mindate=YYYY/MM/DD
maxdate=YYYY/MM/DD
```

## Fetch Abstracts (EFetch)

```
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi
```

**Parameters:**
```
db=pubmed
id=<PMID1,PMID2,...>   # comma-separated, max ~200 for routine
rettype=abstract       # or "medline", "xml", "uilist"
retmode=text           # or "xml"
```

## Most-Used Field Tags

| Tag | Meaning |
|---|---|
| `[tiab]` | Title or abstract (most common for keyword search) |
| `[mh]` | MeSH term (includes narrower terms automatically) |
| `[majr]` | MeSH term as major topic only |
| `[pt]` | Publication type |
| `[nm]` | Substance name (for drugs/compounds) |
| `[au]` / `[1au]` / `[lastau]` | Author / first author / last author |
| `[dp]` | Publication date |
| `[la]` | Language |
| `[affil]` | Affiliation |

## Routine Query Patterns

```
# Systematic review with date range
(topic[mh] OR topic[tiab]) AND systematic review[pt] AND 2020:2024[dp]

# Free full-text RCTs on a drug for a disease
drug[nm] AND disease[mh] AND randomized controlled trial[pt] AND free full text[sb]

# PICO: Population + Intervention/Comparison + Outcome
disease[mh] AND (drug_A[nm] OR drug_B[tiab]) AND outcome[tiab] AND randomized controlled trial[pt]

# Gene + disease + expression
gene_name[tiab] AND (gene expression[mh] OR mRNA[tiab]) AND disease[tiab]
```

## Python (Biopython)

```python
from Bio import Entrez
Entrez.email = "your@email.com"

handle = Entrez.esearch(db="pubmed", term="macrophage[mh] AND lung transplantation[mh]",
                        retmax=200, usehistory="y")
record = Entrez.read(handle)
pmids = record["IdList"]

fetch_handle = Entrez.efetch(db="pubmed", id=",".join(pmids),
                              rettype="abstract", retmode="text")
abstracts = fetch_handle.read()
```

## Rate Limits

3 requests/sec without API key; 10/sec with NCBI API key. Add `api_key=YOUR_KEY` parameter for higher throughput.
