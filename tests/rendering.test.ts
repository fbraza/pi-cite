import assert from "node:assert/strict";
import test from "node:test";
import { Text, stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { createEuropePmcFulltextTool } from "../src/europe-pmc.ts";
import { createLiteratureSearchTool } from "../src/literature-search.ts";
import { createPubmedSearchTool } from "../src/pubmed.ts";
import { createZoteroSearchTool } from "../src/zotero.ts";
import {
  formatFoundLine, padText, paperIdentifier, truncateText,
  renderEuropePmcFulltextResult, renderLiteratureSearchResult, renderProviderSearchResult,
  MAX_EXPANDED_FULLTEXT_SECTIONS, MAX_FULLTEXT_PREVIEW_COLUMNS,
} from "../src/rendering.ts";
import type { EuropePmcFulltextResult, EuropePmcUnavailableResult, EuropePmcUnavailableReason } from "../src/output-schemas.ts";

const collapsed = { expanded: false, isPartial: false };
const expanded = { expanded: true, isPartial: false };
const paper = { title: "Evidence paper", authors: ["Jane Smith"], pmid: "123", source: "pubmed" };

function text(component: Component, width = 120): string {
  return component.render(width).map(stripTerminalSequences).map(line => line.trimEnd()).join("\n");
}

function fulltextFixture(overrides: Partial<EuropePmcFulltextResult> = {}): EuropePmcFulltextResult {
  return {
    tool: "europe_pmc_fulltext", status: "full_text",
    identifier: { type: "pmcid", normalized: "PMC555" },
    metadata: { title: "Evidence paper", author_string: "Smith J", journal: "Journal", year: "2024", doi: "10.1000/example", pmid: "123", pmcid: "PMC555", license: "CC BY", is_open_access: true },
    sections: [{ section: "results", heading: "Results", text: "Evidence excerpt.", truncated: false }],
    requested_sections: ["results"], missing_sections: [], section_fallback: false,
    truncated: false, max_chars: 18000, returned_chars: 17,
    provenance: { provider: "Europe PMC", api_version: "6.9", search_url: "https://example.test/search?query=PMC555", full_text_url: "https://example.test/PMC555/fullTextXML" },
    urls: { europe_pmc: "https://europepmc.org/article/PMC/PMC555", pmc: "https://europepmc.org/articles/PMC555", doi: "https://doi.org/10.1000/example" },
    ...overrides,
  };
}

const unavailableReasons: EuropePmcUnavailableReason[] = ["not_found", "ambiguous_match", "not_open_access", "no_pmcid", "xml_not_available", "source_too_large"];

function unavailable(reason: EuropePmcUnavailableReason): EuropePmcUnavailableResult {
  return {
    tool: "europe_pmc_fulltext", status: "unavailable", reason, recommended_fallback: "pubmed_abstract",
    identifier: { type: "pmcid", normalized: "PMC555" },
    provenance: { provider: "Europe PMC", api_version: "6.9", search_url: "https://example.test/search?query=PMC555" },
  };
}

test("model-output artifacts are visible without confusing them with returned-excerpt truncation", () => {
  const model_output = { truncated: true as const, max_bytes: 32768, original_bytes: 100000, full_result_bytes: 100000, full_result_path: "/tmp/pi-cite-evidence-test/result.json" };
  const renderers = [
    (options: typeof collapsed) => renderProviderSearchResult("pubmed", { details: { count: 1, papers: [paper], model_output } }, options),
    (options: typeof collapsed) => renderProviderSearchResult("zotero", { details: { count: 1, papers: [paper], model_output } }, options),
    (options: typeof collapsed) => renderLiteratureSearchResult({ details: { count: 1, papers: [paper], model_output } }, options),
    (options: typeof collapsed) => renderEuropePmcFulltextResult({ details: { ...fulltextFixture(), model_output } }, options),
    (options: typeof collapsed) => renderEuropePmcFulltextResult({ details: { ...unavailable("not_open_access"), model_output } }, options),
  ];
  for (const renderer of renderers) {
    assert.match(text(renderer(collapsed)), /model preview truncated/);
    const output = text(renderer(expanded));
    assert.match(output, /Model preview truncated; complete JSON:/);
    assert.match(output, /\/tmp\/pi-cite-evidence-test\/result.json/);
    assert.doesNotMatch(output, /Returned excerpts are truncated/);
  }
});

test("all tool factories forward context-only failures and argument fallbacks without success markers", () => {
  for (const tool of [createPubmedSearchTool(), createZoteroSearchTool(), createLiteratureSearchTool(), createEuropePmcFulltextTool()]) {
    for (const options of [collapsed, expanded, { expanded: true, isPartial: true }]) {
      const rendered = text(tool.renderResult({ content: [{ type: "text", text: "HTTP 503: service unavailable" }], details: {} }, options, undefined, {
        isError: true, args: { query: "fallback query", pubmed_query: "fallback query", identifier: "PMC555" },
      }));
      assert.match(rendered, /failed/);
      assert.match(rendered, /HTTP 503/);
      assert.doesNotMatch(rendered, /✓|done:|no .*papers found/);
      if (options.expanded) assert.match(rendered, tool.name === "europe_pmc_fulltext" ? /identifier: PMC555/ : /query: fallback query/);
    }
  }
});

test("result error flags are honored even without a context, including empty error content", () => {
  for (const render of [
    () => renderProviderSearchResult("pubmed", { isError: true, details: { papers: [paper] } }, collapsed),
    () => renderLiteratureSearchResult({ isError: true, details: { count: 4 } }, collapsed),
    () => renderEuropePmcFulltextResult({ isError: true, details: fulltextFixture() }, collapsed),
  ]) {
    assert.match(text(render()), /failed: Tool execution failed/);
    assert.doesNotMatch(text(render()), /✓/);
  }
});

test("provider renderers use counts, retain bounded previews, and prefer result queries over call arguments", () => {
  for (const provider of ["pubmed", "zotero"] as const) {
    const details = { count: 7, papers: Array.from({ length: 7 }, () => paper), query: "filtered query" };
    assert.match(text(renderProviderSearchResult(provider, { details }, collapsed)), /✓ .* 7 papers/);
    const rendered = text(renderProviderSearchResult(provider, { details }, expanded, undefined, { args: { query: "original query" } }));
    assert.match(rendered, /q1: filtered query/);
    assert.doesNotMatch(rendered, /original query/);
    assert.equal((rendered.match(/✓ found:/g) ?? []).length, 5);
    assert.match(rendered, /2 more candidate papers/);
    assert.match(rendered, /✓ done: 7 papers/);
    assert.match(text(renderProviderSearchResult(provider, { details: { count: 1 } }, collapsed)), /1 paper$/);
    assert.match(text(renderProviderSearchResult(provider, { details: { papers: [] } }, expanded)), /done: 0 papers/);
    assert.match(text(renderProviderSearchResult(provider, { details: { papers: [paper] } }, expanded, undefined, { args: { query: "fallback query" } })), /q1: fallback query/);
    assert.match(text(renderProviderSearchResult(provider, { details: { params: { query: "legacy query" }, papers: [] } }, expanded)), /q1: legacy query/);
  }
});

test("partial search results stay partial, use call queries, and report provider failures", () => {
  for (const provider of ["pubmed", "zotero"] as const) {
    const rendered = text(renderProviderSearchResult(provider, { content: [{ type: "text", text: "Fetching abstracts…" }] }, { expanded: true, isPartial: true }, undefined, { args: { query: "query from call" } }));
    assert.match(rendered, /● .*Fetching abstracts…/);
    assert.match(rendered, /query: query from call/);
    assert.doesNotMatch(rendered, /✓/);
  }
  for (const event of [
    { phase: "start" as const },
    { phase: "query_start" as const, provider: "pubmed" as const, query_index: 1, query: "q" },
    { phase: "query_results" as const, provider: "pubmed" as const, query_index: 1, query: "q", count: 1 },
    { phase: "zotero_start" as const },
    { phase: "zotero_progress" as const, library_items: 25, total: 100 },
    { phase: "zotero_results" as const, library_items: 100, matched: 1, total_candidates: 2 },
    { phase: "dedupe" as const },
    { phase: "complete" as const, count: 0 },
    { phase: "query_error" as const, provider: "zotero" as const, query_index: 0, query: "ownership scan", error: "HTTP 401" },
  ]) {
    const rendered = text(renderLiteratureSearchResult({ details: { events: [event] } }, { expanded: true, isPartial: true }, undefined, { args: { pubmed_query: "query from call" } }));
    assert.match(rendered, /query: query from call/);
    assert.doesNotMatch(rendered, /✓/);
    if (event.phase === "query_error") assert.match(rendered, /Zotero failed: HTTP 401/);
  }
});

test("literature summaries distinguish ownership warnings from primary failure or successful matches", () => {
  const details = { count: 1, papers: [{ ...paper, in_zotero: true }], providers: { pubmed: { searched: true, query: "filtered" }, zotero: { searched: true, count: 500 } } };
  const rendered = text(renderLiteratureSearchResult({ details }, expanded));
  assert.match(rendered, /1 PubMed paper · 1 already in Zotero/);
  assert.doesNotMatch(rendered, /500.*papers/);
  const warning = { ...details, papers: [paper], providers: { ...details.providers, zotero: { searched: false, reason: "HTTP 401: ownership unavailable" } } };
  assert.match(text(renderLiteratureSearchResult({ details: warning }, collapsed)), /✓ .*Zotero ownership check unavailable/);
  assert.match(text(renderLiteratureSearchResult({ details: warning }, expanded)), /HTTP 401/);
  const empty = { count: 0, papers: [], providers: { zotero: { searched: false, reason: "No PubMed candidates to check" } } };
  assert.equal(text(renderLiteratureSearchResult({ details: empty }, collapsed)), "✓ literature_search no PubMed papers found");
  assert.match(text(renderLiteratureSearchResult({ details: { papers: [paper] } }, expanded, undefined, { args: { pubmed_query: "fallback query" } })), /query: fallback query/);
});

test("missing final details never masquerade as an empty successful search or full-text retrieval", () => {
  for (const component of [
    renderProviderSearchResult("pubmed", {}, collapsed), renderProviderSearchResult("zotero", {}, expanded),
    renderLiteratureSearchResult({}, collapsed), renderEuropePmcFulltextResult({}, expanded),
  ]) {
    assert.match(text(component), /result details unavailable/);
    assert.doesNotMatch(text(component), /✓|0 papers|no matching scientific prose/);
  }
});

test("Europe PMC compact and expanded success views retain citations, provenance, and excerpts", () => {
  const details = fulltextFixture();
  const before = structuredClone(details);
  const compact = text(renderEuropePmcFulltextResult({ details }, collapsed));
  assert.match(compact, /✓ europe_pmc_fulltext 1 section of open-access excerpts · 17 chars · PMC555/);
  assert.doesNotMatch(compact, /Evidence excerpt/);
  const rendered = text(renderEuropePmcFulltextResult({ details }, expanded));
  for (const expected of ["Evidence paper", "Smith J", "Journal · 2024", "DOI:10.1000/example", "PMID:123", "PMCID:PMC555", "provenance: Europe PMC · API 6.9 · open access: yes", "license: CC BY", "source: https://example.test/PMC555/fullTextXML", "search: https://example.test/search?query=PMC555", "requested sections: results", "Results [results]", "Evidence excerpt."]) assert.ok(rendered.includes(expected), expected);
  assert.deepEqual(details, before);
});

test("every expected Europe PMC unavailable reason is data rather than a failed or successful full-text call", () => {
  for (const reason of unavailableReasons) {
    const details = unavailable(reason);
    for (const options of [collapsed, expanded]) {
      const rendered = text(renderEuropePmcFulltextResult({ details }, options));
      assert.ok(rendered.includes(`unavailable: ${reason}`));
      assert.match(rendered, /PMC555/);
      assert.doesNotMatch(rendered, /✓| failed/);
      if (options.expanded) {
        assert.match(rendered, /fallback: PubMed abstract \(not fetched\)/);
        assert.match(rendered, /provenance: Europe PMC/);
      }
    }
  }
});

test("Europe PMC renders retrieval progress and empty scientific evidence accurately", () => {
  const progress = text(renderEuropePmcFulltextResult({ content: [{ type: "text", text: "Resolving Europe PMC paper: PMC555" }] }, { expanded: false, isPartial: true }));
  assert.match(progress, /● europe_pmc_fulltext Resolving Europe PMC paper: PMC555/);
  assert.doesNotMatch(progress, /✓/);
  const empty = fulltextFixture({ sections: [], returned_chars: 0, missing_sections: ["results"] });
  assert.match(text(renderEuropePmcFulltextResult({ details: empty }, collapsed)), /no matching scientific prose · 0 chars/);
  assert.match(text(renderEuropePmcFulltextResult({ details: empty }, expanded)), /missing sections: results/);
});

test("Europe PMC separates returned-excerpt truncation, missing sections, fallback, and bounded UI previews", () => {
  const details = fulltextFixture({
    truncated: true, section_fallback: true, missing_sections: ["methods"],
    sections: Array.from({ length: 7 }, (_, index) => ({ section: "other", heading: `Section ${index + 1}`, text: "界".repeat(1000), truncated: index === 0 })),
  });
  const component = renderEuropePmcFulltextResult({ details }, expanded);
  const rendered = text(component, 1000);
  assert.match(text(renderEuropePmcFulltextResult({ details }, collapsed)), /truncated/);
  assert.match(rendered, /Returned excerpts are truncated; this is not the complete article/);
  assert.match(rendered, /missing sections: methods/);
  assert.match(rendered, /section fallback: using unclassified body prose/);
  assert.match(rendered, /Section 1 \[other\] \(excerpt truncated\)/);
  assert.equal((rendered.match(/Section \d/g) ?? []).length, MAX_EXPANDED_FULLTEXT_SECTIONS);
  assert.match(rendered, /2 more sections/);
  assert.match(rendered, /UI preview only; complete returned excerpts/);
  for (const line of component.render(1000).map(stripTerminalSequences).filter(line => line.startsWith("  界"))) assert.ok(visibleWidth(line) <= MAX_FULLTEXT_PREVIEW_COLUMNS + 2);
  assert.equal(details.sections[0].text.length, 1000);
});

test("width helpers measure columns, preserve graphemes, and retain plain-text ASCII behavior", () => {
  assert.equal(truncateText("abcdef", 4), "abc…");
  assert.equal(truncateText("免疫学研究", 5), "免疫…");
  assert.equal(truncateText("e\u0301clair", 3), "e\u0301c…");
  assert.equal(truncateText("👩🏾‍🔬👩🏾‍🔬", 3), "👩🏾‍🔬…");
  assert.equal(truncateText("text", 0), "");
  assert.equal(padText("免疫", 6), "免疫  ");
  assert.equal(padText("e\u0301", 3), "e\u0301  ");
  assert.equal(truncateText("\x1b[31mabcdef\x1b[0m", 4), "abc…");
  assert.equal(paperIdentifier({ title: "PMC only", pmcid: "PMC555" }), "PMCID:PMC555");
  assert.equal(paperIdentifier({ title: "Zotero only", zotero_key: "ZOTKEY" }), "Zotero:ZOTKEY");
});

test("provider tables adapt to narrow widths and all renderers fit Unicode, ANSI, and resize boundaries", () => {
  const unicode = { ...paper, title: "免疫🧬e\u0301".repeat(40), authors: ["研究者 👩🏾‍🔬"] };
  const theme = { fg: (_name: string, value: string) => `\x1b[32m${value}\x1b[0m` };
  const compactPaper = { first_author: "研究者", title: unicode.title, id: "PMID:123", source: "PM" };
  assert.equal(visibleWidth(formatFoundLine(compactPaper, theme, 80)), 80);
  assert.match(formatFoundLine(compactPaper, theme, 32), /\n    .*PMID:123/);
  for (const component of [
    renderProviderSearchResult("pubmed", { details: { papers: [unicode], query: unicode.title } }, expanded, theme),
    renderLiteratureSearchResult({ details: { papers: [unicode] } }, expanded, theme),
    renderEuropePmcFulltextResult({ details: fulltextFixture({ metadata: { title: unicode.title, is_open_access: true } }) }, expanded, theme),
    renderEuropePmcFulltextResult({ details: unavailable("not_found") }, expanded, theme),
  ]) {
    for (const width of [0, 1, 2, 12, 32, 80, 120, 32]) {
      const lines = component.render(width);
      if (!width) assert.deepEqual(lines, []);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
    }
  }
  const narrow = text(renderProviderSearchResult("pubmed", { details: { papers: [unicode] } }, expanded), 32);
  assert.match(narrow, /PMID:123/);
});

test("owned result components reuse lastComponent, update states, and rebuild colors on invalidation", () => {
  let ansi = "\x1b[31m";
  const theme = { fg: (_name: string, value: string) => `${ansi}${value}\x1b[0m` };
  const first = renderLiteratureSearchResult({ details: { count: 1 } }, collapsed, theme);
  const before = first.render(120).join("\n");
  const cached = first.render(120);
  assert.strictEqual(first.render(120), cached);
  ansi = "\x1b[34m";
  first.invalidate();
  assert.notEqual(first.render(120).join("\n"), before);
  assert.ok(first.render(120).join("\n").includes(ansi));
  const next = renderLiteratureSearchResult({ details: { count: 0 } }, collapsed, theme, { lastComponent: first });
  assert.strictEqual(next, first);
  assert.match(text(next), /no PubMed papers found/);
  const failed = renderLiteratureSearchResult({ content: [{ type: "text", text: "cancelled" }] }, expanded, undefined, { lastComponent: next, isError: true });
  assert.strictEqual(failed, next);
  assert.match(text(failed), /failed/);
  assert.doesNotMatch(text(failed), /✓/);
  const foreign = new Text("other renderer", 0, 0);
  const fresh = renderProviderSearchResult("zotero", { details: { papers: [] } }, collapsed, undefined, { lastComponent: foreign });
  assert.notStrictEqual(fresh, foreign);
  assert.equal(text(foreign), "other renderer");
});

test("rendering remains usable without a theme or with failing theme callbacks", () => {
  const theme = { fg: () => { throw new Error("theme unavailable"); }, bold: () => { throw new Error("theme unavailable"); } };
  assert.match(text(renderEuropePmcFulltextResult({ details: fulltextFixture() }, expanded, theme)), /Evidence excerpt/);
  assert.match(text(renderProviderSearchResult("pubmed", { details: { papers: [paper] } }, expanded, theme)), /Evidence paper/);
});
