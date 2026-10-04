---
name: literature
description: Unified literature search, verification, and synthesis workflow for scientific questions. Use when any biological claim needs a verified citation, when reviewing a gene/pathway/disease/drug/target, when surveying preclinical evidence for a target in a disease, when checking novelty, or when turning a paper set into a structured hypothesis synthesis.
allowed-tools: Read, Write, WebFetch, WebSearch, codemode, literature_search, pubmed_search, zotero_search, europe_pmc_fulltext
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
- Ground substantive claims in returned full abstracts or Europe PMC excerpts, never search-result snippets or metadata alone.
- Never overwrite outputs from a previous literature search.
- Never write literature-review outputs directly to generic shared paths under `results/`.

## Standard workflow

### Step 1 — Clarify scope

Determine:
- exact claim, topic, target, or disease
- desired time range
- species restrictions
- study type filters
- whether the task is **general review** or **preclinical extraction mode**
- whether full text is explicitly requested

Ask at most one concise clarification round, and only for materially missing scope that would change the search. Do not re-ask facts the user supplied. If clarification is unnecessary or unanswered, proceed without blocking using the stated defaults: all dates, species, and study designs; general review mode; and abstract-level evidence.

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
- Set `fetch_abstracts: true`. Abstracts are the default evidence depth.

For a broad review, decompose the scope into 2–4 focused, PubMed-ready queries. Use synonyms and relevant facets such as mechanism, intervention, outcomes, and study design rather than relying on one oversized query. A narrow claim-verification task may use one focused query. Call `literature_search` separately for each query, then merge and deduplicate results in this order:
1. DOI
2. PMID
3. PMCID
4. normalized title plus publication year

Record every exact query, its returned count, provider warnings/failures, and the final deduplicated count in `search_log.md`. When codemode is active, read `references/codemode-workflows.md`: batch at most two queries at a time with `Promise.allSettled`, consume structured objects directly, deduplicate using all available identifiers, save complete results through the `write` tool, and print only selected evidence. Keep only small state such as selected IDs or a saved path in `store()`.

Separate `literature_search` calls repeat the read-only Zotero library scan; no ownership cache is implied. Avoid redundant scans and use `pubmed_search` when ownership checking is specifically not needed. The extension serializes requests per provider and honors shared pacing/backoff within its loaded runtime; this is not a cross-process quota or permission to issue unlimited parallel calls.

Direct-call final text is bounded to 32 KiB in UTF-8 bytes. If `model_output.truncated` is present, follow `model_output.full_result_path` to the complete JSON result using `read` (offset/limit) or `bash` projection, then save required evidence in the review folder. `abstract_excerpt`/`text_excerpt` and shortened metadata are previews, not full evidence; read explicitly omitted identifiers/URLs/warnings from the complete file before citing. Structured codemode data remains complete. Successful scratch files survive session shutdown but may be removed by the OS; copy them for durable retention.

These extension tools are the preferred search path for this skill. Do not fall back to generic `WebFetch` / `WebSearch` first when one of these typed tools fits the task.

When the `ZOTERO_API_KEY` environment variable is set, `literature_search` automatically cross-checks PubMed candidates against the user's Zotero library after the PubMed search and flags papers already owned (`in_zotero: true`, with the matching `zotero_key`). The library is scanned once per non-empty `literature_search` call (top-level items, capped at ~2000) and matched by DOI, PMID, PMCID, or title-year — so it catches matches even when one source is missing an identifier. No papers are written to the Zotero library; it is used read-only as a source of truth for "already have this". When no key is set, this step is skipped entirely.

The standalone `zotero_search` tool searches the Zotero library directly by keyword (title/creators/year, and indexed full text when `qmode=everything`) and is useful when you want to surface papers you already own on a topic without going through PubMed.

Read these references before constructing queries:
- `references/pubmed_routine.md`
- `references/pubmed_search_syntax.md`
- `references/pubmed_common_queries.md`

#### Optional full-text escalation

Only retrieve full text when the user explicitly requests it. By default, escalate the 5 most pivotal papers, with a hard cap of 10. Call `europe_pmc_fulltext` once per selected paper, passing exactly one `identifier` and preferring PMCID, then DOI, then PMID; use optional `sections` or `max_chars` only to focus or bound that paper's excerpts. This tool retrieves only Europe PMC open-access JATS and is not a search or batch tool. In codemode, submit at most two single-paper calls at a time using `Promise.allSettled`; save complete successful/unavailable results and failures before printing a small evidence projection. See `references/codemode-workflows.md` for examples and cancellation behavior.

- On `status: full_text`, use the returned structured section excerpts. If `truncated` is true, describe the evidence as an **OA full-text excerpt**, not as the complete paper having been read.
- On `status: unavailable` or tool error, use the full PubMed abstract as fallback and record the reason. Do not substitute generic web retrieval as the primary path.
- In `search_log.md`, record the identifier used, OA status and license, retrieval URL, returned sections, truncation state, and any fallback reason.
- For every paper in a full-text-requested report, explicitly set `evidence_source` for table generation, using values such as `Europe PMC OA full-text excerpt`, `PubMed abstract (fallback)`, or `Metadata only—not used for substantive claims`.

Full-text availability must not raise or lower a paper's evidence-quality ranking; rank the study design and evidence itself.

### Step 4 — Screen and prioritise

- Treat titles and search-result snippets as triage signals only. Use returned full abstracts or requested Europe PMC excerpts as evidence for substantive claims.
- Use the `in_zotero` flag to distinguish papers you already have from those you still need to acquire. The summary table exposes `In Zotero` (Yes/No) plus `DOI` and `Access Link` columns for the non-owned papers: the DOI URL always, and the PMC full-text URL when a PMCID is available.
- Prioritise by relevance, recency, and study type.
- Default to detailed synthesis of the top 20 returned abstracts unless the user asks otherwise.
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

When full text was not requested, use the scripts' defaults and preserve the exact standard table. When full text was requested, call `build_table_rows(..., full_text_requested=True)` or `export_all(..., full_text_requested=True)`. Opt-in generation requires every paper to have an explicit `evidence_source`; never infer or invent provenance.

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

These columns remain before `DOI` and `Access Link`. Only when full text was explicitly requested, append one final column:

```markdown
| Evidence Source |
```

Do not append this column for the default abstract workflow.

## Troubleshooting

- **Too few results:** check field tags and spelling, add established synonyms, and relax one overly narrow facet while keeping the core concept.
- **Off-topic results:** add a discriminating MeSH or title/abstract concept, split the query by facet, and re-screen the merged set.
- **Thin synthesis:** verify full abstracts were returned; do not fill gaps from snippets. Run one focused query for the missing mechanism, outcome, or study design.
- **OA text unavailable:** use the PubMed abstract fallback and log the unavailable/error reason; do not imply full-text review.
- **Full-text runs are slow:** keep the default top 5, retrieve once per paper, and never exceed 10.

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
- `references/codemode-workflows.md`

## Companion scripts

- `scripts/extract_experiments.py`
- `scripts/synthesis.py`
- `scripts/generate_table.py`
- `scripts/export_all.py`
