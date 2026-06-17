---
name: literature
description: Unified literature search, verification, full-text retrieval, and synthesis workflow for scientific questions. Use when any biological claim needs a verified citation, when reviewing a gene/pathway/disease/drug/target, when surveying preclinical evidence for a target in a disease, when checking novelty, when retrieving full text for specific papers, or when turning a paper set into a structured hypothesis synthesis.
allowed-tools: Read, Write, WebFetch, WebSearch, literature_search, pubmed_search, semantic_scholar_search, fetch_fulltext
starting-prompt: Conduct a literature review on my research topic with verified citations, structured synthesis, and a per-paper summary table.
---

# Literature

Unified literature skill replacing the previous split review and preclinical workflows.

## What this skill covers

Use this skill when you need to:
- verify any biological claim with a real citation
- review literature on a gene, pathway, disease, drug, or molecular target
- survey preclinical evidence for a target in a disease context
- check whether a finding appears novel or already published
- retrieve full text or PDFs for key papers
- synthesize a paper set into hypotheses, contradictions, and evidence-weighted conclusions

Do not use this skill for:
- running computational omics analyses
- generating figures without a literature component
- inventing or guessing citations

## Hard rules

- Every citation must be real and verifiable.
- Never fabricate PMIDs, DOIs, titles, journals, years, or author lists.
- Distinguish human, animal, and in vitro evidence.
- Weight evidence quality by study design and replication.
- Record how full text was obtained for each paper.
- Use inline numbered citations like `[1]` or `[1, 2]` in narrative synthesis.
- Never overwrite outputs from a previous literature search.
- Never write literature-review outputs directly to generic shared paths under `results/`.

## Standard workflow

### Step 1 — Clarify scope

Always clarify:
- exact claim, topic, target, or disease
- desired time range
- species restrictions
- study type filters
- whether the task is **general review** or **preclinical extraction mode**

### Step 2 — Create a dedicated output folder

For every new literature review or literature research task, create a new dedicated folder inside `results/` before generating files.

The folder name must describe the search session/topic clearly, for example:
- `results/literature_multiomics_ML_biomarkers_PGD/`
- `results/literature_siRNA_lung_transplant_new_treatments/`

All generated files for that search session must be saved inside this dedicated folder, including:
- `literature_report.md`
- `paper_summary_table.csv`
- `search_log.md`
- `pdfs/`
- any optional analysis/export artifacts such as `analysis_object.pkl`

Never write directly to generic shared paths such as:
- `results/literature_report.md`
- `results/paper_summary_table.csv`
- `results/analysis_object.pkl`
- `results/literature_pdfs/`

If a folder for a previous search already exists, create a new folder with a distinct descriptive search-session title rather than using versioned filenames.

At the end of the task, clearly report the exact output folder and generated file paths to the user.

### Step 3 — Search

Use the custom literature tool as the primary search path:
- **Primary:** `literature_search`

When calling `literature_search`:
- Always construct `pubmed_query` using PubMed-specific syntax from the references below.
- Use MeSH terms (`[mh]` / `[majr]`), title/abstract terms (`[tiab]`), publication types (`[pt]`), substance names (`[nm]`), date filters, and Boolean logic as appropriate.
- Construct `semantic_scholar_query` separately as broader natural-language search terms when useful. Semantic Scholar is used automatically as supplementary search only when `SEMANTIC_SCHOLAR_API_KEY` is configured.
- Do not pass a generic natural-language query as `pubmed_query` when a PubMed/MeSH query can be constructed.

These extension tools are the preferred search path for this skill. Do not fall back to generic `WebFetch` / `WebSearch` first when one of these typed tools fits the task.

Read these references before constructing queries:
- `references/pubmed_routine.md`
- `references/pubmed_search_syntax.md`
- `references/pubmed_common_queries.md`
- `references/semanticscholar_routine.md`

### Step 4 — Screen and prioritise

- Deduplicate across PubMed and Semantic Scholar sources.
- Prioritise by relevance, recency, citation count, and study type.
- Default to deep reading of the top 20 papers unless the user asks otherwise.
- For preclinical requests, keep studies with experimental target perturbation evidence.

### Step 5 — Retrieve full text

Use `fetch_fulltext` for top papers. Prefer it over ad-hoc `WebFetch` PDF retrieval because it applies the defined PMC → publisher OA → Sci-Hub chain.

Access chain:
1. PMC
2. publisher open-access page
3. Sci-Hub fallback

Read:
- `references/full-text-access-guide.md`
- `references/scihub_routine.md`

### Step 6 — Synthesis

Always produce:
1. a narrative synthesis with inline numbered citations
2. a per-paper structured summary table

When in **preclinical extraction mode**, add:
- Experiment Type
- Model System
- Assay/Endpoint
- Finding Direction

Use:
- `scripts/synthesis.py`
- `scripts/generate_table.py`
- `scripts/export_all.py`

For preclinical extraction details, read:
- `references/preclinical-extraction-guide.md`
- `scripts/extract_experiments.py`

## Evidence quality framework

Rank evidence broadly as:
- **High:** replicated clinical evidence, meta-analysis, systematic review, strong human studies
- **Moderate:** strong animal studies, coherent multi-model evidence, robust mechanistic studies
- **Low/Preliminary:** single-study results, purely computational inference, unreplicated in vitro work

### What to mark as preliminary
- single-study findings
- animal-only findings for human claims
- in vitro findings without in vivo follow-up

### What to refuse without qualification
- causal claims from correlational studies
- claims supported only by retracted work
- claims contradicting the weight of evidence

## Output format

### Narrative section

Use concise prose with inline citations.

### Paper Summary Table

```markdown
## Paper Summary Table

| # | PMID/DOI | Authors (year) | Key Message | Key Results | Key Methods | Study Type | Evidence Quality |
|---|---|---|---|---|---|---|---|
```

### Extra columns for preclinical extraction mode

```markdown
| Experiment Type | Model System | Assay/Endpoint | Finding Direction |
```

## Hypothesis synthesis

After reviewing the core paper set, optionally produce:
- explicit hypotheses stated by authors
- implicit mechanistic hypotheses inferred from evidence
- contradiction matrix across papers
- highest-confidence next-step hypotheses

## Expected files

Typical outputs must be placed in a dedicated search-session folder under `./results/`, for example `./results/literature_<descriptive_topic>/`:
- `literature_report.md`
- `paper_summary_table.csv`
- `search_log.md`
- `pdfs/`
- optional `analysis_object.pkl` or other export artifacts when produced

Do not write these outputs directly to `./results/` or reuse a previous search folder.

## Companion references

- `references/pubmed_api_reference.md`
- `references/pubmed_routine.md`
- `references/pubmed_search_syntax.md`
- `references/pubmed_common_queries.md`
- `references/semanticscholar_routine.md`
- `references/preclinical-extraction-guide.md`
- `references/full-text-access-guide.md`
- `references/scihub_routine.md`

## Companion scripts

- `scripts/extract_experiments.py`
- `scripts/synthesis.py`
- `scripts/generate_table.py`
- `scripts/export_all.py`
- `scripts/scihub_pdf_resolver.py`
