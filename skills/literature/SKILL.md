---
name: literature
description: Unified literature search, verification, and synthesis workflow for scientific questions. Use when any biological claim needs a verified citation, when reviewing a gene/pathway/disease/drug/target, when surveying preclinical evidence for a target in a disease, when checking novelty, or when turning a paper set into a structured hypothesis synthesis.
allowed-tools: Read, Write, WebFetch, WebSearch, literature_search, pubmed_search, zotero_search
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

For every new literature review or literature research task, create a new dedicated folder under `results/literature_review/` before generating files.

Use the path `results/literature_review/<subject_of_study>/`, where `<subject_of_study>` is a short **snake_case title summary of the theme** of the literature search. Derive it from the scope clarified in Step 1: lower case, words separated by single underscores, no spaces, hyphens, or punctuation. For example, a review on **trained immunity in transplantation** becomes:

- `results/literature_review/trained_immunity_in_transplantation/`

Other examples:
- `results/literature_review/sirna_lung_transplant_new_treatments/`
- `results/literature_review/multiomics_ml_biomarkers_in_pgd/`

All generated files for that search session must be saved inside this dedicated subject folder, including:
- `literature_report.md`
- `paper_summary_table.csv`
- `search_log.md`
- any optional analysis/export artifacts such as `analysis_object.pkl`

Never write outputs directly to the parent folder or to the `results/` root, for example:
- `results/literature_review/literature_report.md`
- `results/literature_review/paper_summary_table.csv`
- `results/literature_review/analysis_object.pkl`
- `results/literature_report.md`

If a folder for a previous search on the same subject already exists, create a new folder with a distinct descriptive `<subject_of_study>` title rather than using versioned filenames.

At the end of the task, clearly report the exact output folder and generated file paths to the user.

### Step 3 — Search

Use the custom literature tool as the primary search path:
- **Primary:** `literature_search`

When calling `literature_search`:
- Always construct `pubmed_query` using PubMed-specific syntax from the references below.
- Use MeSH terms (`[mh]` / `[majr]`), title/abstract terms (`[tiab]`), publication types (`[pt]`), substance names (`[nm]`), date filters, and Boolean logic as appropriate.
- Do not pass a generic natural-language query as `pubmed_query` when a PubMed/MeSH query can be constructed.

These extension tools are the preferred search path for this skill. Do not fall back to generic `WebFetch` / `WebSearch` first when one of these typed tools fits the task.

When the `ZOTERO_API_KEY` environment variable is set, `literature_search` automatically cross-checks PubMed candidates against the user's Zotero library after the PubMed search and flags papers already owned (`in_zotero: true`, with the matching `zotero_key`). The full library is fetched once (top-level items, capped at ~2000) and matched by DOI, PMID, PMCID, or title-year — so it catches matches even when one source is missing an identifier. No papers are written to the Zotero library; it is used read-only as a source of truth for "already have this". When no key is set, this step is skipped entirely.

The standalone `zotero_search` tool searches the Zotero library directly by keyword (title/creators/year, and indexed full text when `qmode=everything`) and is useful when you want to surface papers you already own on a topic without going through PubMed.

Read these references before constructing queries:
- `references/pubmed_routine.md`
- `references/pubmed_search_syntax.md`
- `references/pubmed_common_queries.md`

### Step 4 — Screen and prioritise

- Deduplicate PubMed results.
- Use the `in_zotero` flag to distinguish papers you already have from those you still need to acquire. The summary table exposes `In Zotero` (Yes/No) plus `DOI` and `Access Link` columns for the non-owned papers: the DOI URL always, and the PMC full-text URL when a PMCID is available.
- Prioritise by relevance, recency, and study type.
- Default to deep reading of the top 20 papers unless the user asks otherwise.
- For preclinical requests, keep studies with experimental target perturbation evidence.

### Step 5 — Synthesis

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

| # | PMID/DOI | In Zotero | Authors (year) | Key Message | Key Results | Key Methods | Study Type | Evidence Quality | DOI | Access Link |
|---|---|---|---|---|---|---|---|---|---|---|
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

Typical outputs must be placed in a dedicated subject folder under `./results/literature_review/`, for example `./results/literature_review/<subject_of_study>/`:
- `literature_report.md`
- `paper_summary_table.csv`
- `search_log.md`
- optional `analysis_object.pkl` or other export artifacts when produced

Do not write these outputs directly to `./results/literature_review/` or to `./results/`, and do not reuse a previous subject folder.

## Companion references

- `references/pubmed_api_reference.md`
- `references/pubmed_routine.md`
- `references/pubmed_search_syntax.md`
- `references/pubmed_common_queries.md`
- `references/preclinical-extraction-guide.md`

## Companion scripts

- `scripts/extract_experiments.py`
- `scripts/synthesis.py`
- `scripts/generate_table.py`
- `scripts/export_all.py`
