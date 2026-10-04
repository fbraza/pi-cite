# Structured codemode workflows

Use these patterns only when codemode is active; otherwise call the literature tools directly. Scripts use `result.papers` and `result.sections`, **not** `JSON.parse(result)`. QuickJS has no direct filesystem, network, Node APIs, or timers: persist data through the available `write` tool, not `fs`.

## Search, retain failures, deduplicate, save, and project

First clarify the scope and prepare a **new** subject folder as described in SKILL.md. Replace the example queries and `reviewDir` below with that scope and folder. Read the PubMed syntax references before constructing queries.

- Submit at most **two searches at a time**, across 2–4 focused queries. Await every batch.
- `literature_search` remains the default when automatic Zotero ownership is needed. Each successful non-empty call may repeat the read-only library scan (up to 2000 items); there is no ownership cache. Do not launch additional calls merely to refresh flags. Use `pubmed_search` when the task specifically does not need ownership checking.
- A failed call does not invalidate other successes. Keep exact queries, counts, provider warnings, and failure reasons in the search log. Do not present a partial search set as exhaustive.
- Deduplicate using **all available aliases**, with priority DOI, PMID, PMCID, then normalized title-year. Preserve identifiers, source attribution, the longest returned abstract, and positive ownership information when merging.
- Write complete successful results before printing a small projection. Do not put paper sets, abstracts, or full-text excerpts into `store()`; store only a few selected IDs, cursors, or a saved path.

```js
// @options: {"max_output_tokens": 6000, "timeout_ms": 180000}
const queries = [
  '"Alzheimer Disease"[mh] AND NLRP3[tiab]',
  'Alzheimer*[tiab] AND inflammasome*[tiab] AND inhibitor*[tiab]'
];
const reviewDir = "results/literature_review/nlrp3_in_alzheimer_disease";
const searches = [];
const failures = [];
for (let start = 0; start < queries.length; start += 2) {
  const batch = queries.slice(start, start + 2);
  const outcomes = await Promise.allSettled(batch.map(pubmed_query =>
    tools.literature_search({ pubmed_query, max_results: 20, fetch_abstracts: true })
  ));
  outcomes.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") searches.push({ query: batch[index], ...outcome.value });
    else failures.push({ query: batch[index], error: String(outcome.reason) });
  });
}
const normalizeDoi = value => value?.trim().replace(/^doi:\s*/i, "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toLowerCase();
function keys(paper) {
  const title = paper.title?.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return [
    paper.doi ? `doi:${normalizeDoi(paper.doi)}` : undefined,
    paper.pmid ? `pmid:${paper.pmid}` : undefined,
    paper.pmcid ? `pmcid:${paper.pmcid.toUpperCase()}` : undefined,
    title && paper.year ? `title-year:${title}:${paper.year}` : undefined
  ].filter(Boolean);
}
const aliases = new Map();
const groups = new Set();
for (const paper of searches.flatMap(search => search.papers)) {
  const matching = new Set(keys(paper).map(key => aliases.get(key)).filter(Boolean));
  const records = [...matching, paper];
  const merged = Object.assign({}, ...records.slice().reverse());
  merged.abstract = records.map(record => record.abstract).filter(Boolean).sort((a, b) => b.length - a.length)[0];
  merged.authors = [...new Set(records.flatMap(record => record.authors ?? []))];
  merged.sources = [...new Set(records.flatMap(record => [...(record.sources ?? []), ...(record.source?.split(";") ?? [])]).filter(Boolean))];
  merged.source = merged.sources.join(";");
  const ownership = records.map(record => record.in_zotero);
  merged.in_zotero = ownership.includes(true) ? true : ownership.includes(false) ? false : undefined;
  merged.zotero_key = records.find(record => record.in_zotero && record.zotero_key)?.zotero_key ?? merged.zotero_key;
  for (const previous of matching) groups.delete(previous);
  // Preserve old aliases, including identifiers joined by a bridging record.
  for (const [key, previous] of aliases) if (matching.has(previous)) aliases.set(key, merged);
  for (const record of records) for (const key of keys(record)) aliases.set(key, merged);
  groups.add(merged);
}
const papers = [...groups];
const savedPath = `${reviewDir}/search_results.json`;
await tools.write({ path: savedPath, content: JSON.stringify({ searches, failures, papers }, null, 2) });
const log = searches.map(search => ({ query: search.query, count: search.count, providers: search.providers }));
text({ searches: log, failures, deduplicated_count: papers.length, saved_path: savedPath });
// Select by relevance/study design before synthesis; these first two are only a small screening projection.
text(papers.slice(0, 2).map(({ pmid, doi, pmcid, title, year, source, in_zotero, zotero_key, abstract }) =>
  ({ pmid, doi, pmcid, title, year, source, in_zotero, zotero_key, abstract })
));
store("literature_review", { saved_path: savedPath, selected_pmids: papers.slice(0, 5).map(paper => paper.pmid).filter(Boolean) });
```

Load additional complete abstracts from the saved file for screening/synthesis. The first two records are not an automatic evidence ranking. Preserve the existing extraction/export scripts' input shapes and table defaults; the saved object has its paper array at `.papers`. If every search failed, log the failures and report that no evidence was retrieved; do not synthesize an empty dataset.

## Selective full-text escalation (explicit opt-in)

Run only after the user requests full text and you select the pivotal papers. Prefer PMCID, then DOI, then PMID. Retrieve once per selected paper: default top 5, hard cap 10; submit at most two at a time. The single-paper tool is not a batch endpoint. Populate `identifiers` with real IDs from the verified candidate set, and use the actual review folder.

```js
// @options: {"max_output_tokens": 4000, "timeout_ms": 180000}
const identifiers = ["PMC555", "10.1000/example"];
const reviewDir = "results/literature_review/nlrp3_in_alzheimer_disease";
if (identifiers.length > 10) throw new Error("Select no more than 10 pivotal papers");
const uniqueIdentifiers = [...new Set(identifiers)];
const evidence = [];
const failures = [];
for (let start = 0; start < uniqueIdentifiers.length; start += 2) {
  const batch = uniqueIdentifiers.slice(start, start + 2);
  const outcomes = await Promise.allSettled(batch.map(identifier =>
    tools.europe_pmc_fulltext({ identifier, sections: ["methods", "results", "discussion"] })
  ));
  outcomes.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") evidence.push(outcome.value);
    else failures.push({ identifier: batch[index], error: String(outcome.reason) });
  });
}
const savedPath = `${reviewDir}/fulltext_results.json`;
await tools.write({ path: savedPath, content: JSON.stringify({ evidence, failures }, null, 2) });
text({ saved_path: savedPath, failures, results: evidence.map(result => ({
  identifier: result.identifier, status: result.status, reason: result.reason,
  recommended_fallback: result.recommended_fallback, provenance: result.provenance,
  license: result.metadata?.license, missing_sections: result.missing_sections, truncated: result.truncated
})) });
text(evidence.filter(result => result.status === "full_text").slice(0, 1).map(result => ({
  identifier: result.identifier, provenance: result.provenance,
  sections: result.sections, truncated: result.truncated, missing_sections: result.missing_sections
})));
```

Expected `unavailable` data is not a failed request. It recommends a PubMed abstract but does **not** fetch it automatically: use the complete abstract already saved, or make a focused PubMed call if absent. Record fallback/error reasons, source URLs, license, requested/missing sections, and per-section/aggregate truncation. A successful result contains bounded OA **excerpts**, not proof that the complete article was reviewed. Availability must not change study-quality ranking.

## Direct-call output limits and artifacts

Final direct-call text is limited to **32 KiB measured in UTF-8 bytes**, including warnings/retrieval instructions. Large results contain valid JSON with `model_output.truncated`, `result_metadata`, and labeled `paper_previews`/`section_previews`. These may contain shortened descriptive metadata arrays/strings and `abstract_excerpt`/`text_excerpt`; they are not complete evidence. Identifiers, source URLs, licenses, and warnings remain verbatim up to 1024 serialized UTF-8 bytes per field; larger values are explicit omission objects. Follow `model_output.full_result_path` with the `read` tool, or use `bash` to parse the file and select a few complete papers/sections. Read omitted identifiers from the complete file before citing.

The artifact is the **complete structured result**: `.papers` for searches, `.sections` for full text. It does not contain UI event histories. Copy it into the dedicated review folder when durable retention is needed. Files are private scratch artifacts (directory mode 0700 and file mode 0600 on POSIX) under the OS temp directory. Failed/cancelled writes are removed; successful files are not deleted on shutdown/reload, to keep transcript paths usable. They may be explicitly deleted or removed by the OS. They may contain private Zotero metadata; do not upload them without permission.

Codemode gets the complete structured object regardless of the tool's text preview; printing everything defeats filtering. Its own output budget may also truncate script output and provide a separate artifact. Save full results through `write` and print only necessary evidence with warnings/provenance.

## Request scheduling and cancellation

All calls in one loaded extension runtime share provider lanes: at most one HTTP request/body read per provider at a time. NCBI starts are separated by at least 350 ms without a key or 120 ms with a key; mixed-key traffic uses the conservative interval. Zotero honors the longest `Backoff`/`Retry-After`; NCBI and Europe PMC honor `Retry-After` seconds or HTTP dates. Failed requests are **not** automatically retried. Different providers can operate concurrently.

Queues/backoff are local to the loaded modules, not a cross-process quota; another Pi process or extension reload does not share them. Keep scripts conservative even with these guards. Cancellation or a codemode deadline aborts queued/backoff waits and propagates to in-flight fetches. Cancelling an ownership check rejects the literature call rather than reporting a successful unchecked search. Await `Promise.allSettled()` batches; calls left pending when a script ends are cancelled. Long backoff or large scans can exceed your script deadline—adjust a deadline deliberately, never spin/retry immediately after rate limiting.
