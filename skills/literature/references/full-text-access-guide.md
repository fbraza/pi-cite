# Full-Text Access Guide

**Workflow:** literature
**Purpose:** Retrieve PDFs for prioritised papers using a consistent fallback chain.

## Access order

1. **PubMed Central (PMC)**
   - Preferred for PubMed-indexed papers with open full text.
   - Use PubMed/PMC linking first when a PMID is available.

2. **Publisher open-access page**
   - Resolve DOI at `https://doi.org/<doi>`.
   - Look for `citation_pdf_url`, explicit PDF links, or embedded PDF viewers.

3. **Sci-Hub fallback**
   - Use only as the final fallback after OA routes are exhausted.
   - Record that Sci-Hub was used.

## Per-paper logging

For each paper, record:
- PMID
- DOI
- source used: `pmc`, `publisher_oa`, `scihub`, or `not_found`
- direct PDF URL if found
- local saved path if downloaded
- access note

## Notes

- PMC and publisher OA should always be attempted before Sci-Hub.
- If no DOI is known but PMID exists, try resolving identifiers from PubMed metadata first.
- If no PDF is found, keep the paper in the synthesis and note `not_found`.
