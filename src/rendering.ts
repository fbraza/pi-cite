import type { Theme, ThemeColor, ToolRenderers, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { PaperRecord } from "./types.ts";
import type { ModelOutputDetails } from "./evidence-output.ts";
import type { EuropePmcResult, EuropePmcUnavailableReason } from "./output-schemas.ts";

export const MAX_STREAMED_PAPERS_PER_QUERY = 5;
export const MAX_EXPANDED_PAPER_PREVIEW = 5;
export const MAX_EXPANDED_FULLTEXT_SECTIONS = 5;
export const MAX_FULLTEXT_PREVIEW_COLUMNS = 320;

type ThemeLike = Partial<Pick<Theme, "fg" | "bold">>;

export type CompactPaperForDisplay = {
  first_author: string;
  title: string;
  id: string;
  source: string;
  year?: number;
  journal?: string;
};

export type ProviderName = "pubmed" | "zotero";

export type LiteratureSearchDisplayEvent =
  | { phase: "start" }
  | {
      phase: "query_start";
      provider: ProviderName;
      query_index: number;
      query: string;
    }
  | {
      phase: "query_results";
      provider: ProviderName;
      query_index: number;
      query: string;
      count: number;
    }
  | {
      phase: "query_error";
      provider: ProviderName;
      query_index: number;
      query: string;
      error: string;
    }
  | { phase: "zotero_start" }
  | { phase: "zotero_progress"; library_items: number; total?: number }
  | {
      phase: "zotero_results";
      library_items: number;
      matched: number;
      total_candidates: number;
    }
  | { phase: "dedupe" }
  | { phase: "complete"; count: number };

export type LiteratureSearchDisplaySearch = {
  provider: ProviderName;
  query_index: number;
  query: string;
  count: number;
  papers: CompactPaperForDisplay[];
};

// Derive the relevant context fields from Pi's exported renderer contract.
// ToolRenderContext itself is not exported by Pi v1.0.1's package root.
type RenderContext = Partial<Pick<Parameters<NonNullable<ToolRenderers["renderResult"]>>[3], "isError" | "lastComponent" | "args">>;

function argument(context: RenderContext | undefined, name: "query" | "pubmed_query" | "identifier"): string | undefined {
  const args: unknown = context?.args;
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

class ResultComponent implements Component {
  private layout: (width: number) => string;
  private cache?: { width: number; lines: string[] };

  constructor(layout: (width: number) => string) {
    this.layout = layout;
  }

  setLayout(layout: (width: number) => string): void {
    this.layout = layout;
    this.invalidate();
  }

  invalidate(): void {
    this.cache = undefined;
  }

  render(width: number): string[] {
    const columns = Math.max(0, Math.floor(width));
    if (!Number.isFinite(columns) || columns === 0) return [];
    if (this.cache?.width === columns) return this.cache.lines;
    // Clamp even an unwrappable wide grapheme at a one-column terminal width.
    const lines = wrapTextWithAnsi(this.layout(columns), columns)
      .map(line => truncateToWidth(line, columns, "…"));
    this.cache = { width: columns, lines };
    return lines;
  }
}

function resultComponent(layout: (width: number) => string, context?: RenderContext): Component {
  if (context?.lastComponent instanceof ResultComponent) {
    context.lastComponent.setLayout(layout);
    return context.lastComponent;
  }
  return new ResultComponent(layout);
}

function displayText(value: unknown): string {
  return stripTerminalSequences(String(value ?? "")).replace(/\s+/g, " ").trim();
}

function color(theme: ThemeLike | undefined, colorName: ThemeColor, text: string): string {
  try {
    return theme?.fg ? theme.fg(colorName, text) : text;
  } catch {
    return text;
  }
}

function bold(theme: ThemeLike | undefined, text: string): string {
  try {
    return theme?.bold ? theme.bold(text) : text;
  } catch {
    return text;
  }
}

export function truncateText(value: unknown, width: number): string {
  return stripTerminalSequences(truncateToWidth(displayText(value), Math.max(0, Math.floor(width)), "…"));
}

export function padText(value: unknown, width: number): string {
  const columns = Math.max(0, Math.floor(width));
  const text = truncateText(value, columns);
  return text + " ".repeat(Math.max(0, columns - visibleWidth(text)));
}

function authorSurname(author: string): string {
  const cleaned = author.trim();
  if (!cleaned) return "Unknown";
  const parts = cleaned.split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : cleaned;
}

export function firstAuthor(paper: PaperRecord): string {
  const authors = paper.authors ?? [];
  if (authors.length === 0) return "Unknown";
  return authorSurname(authors[0]);
}

export function authorRange(paper: PaperRecord): string {
  const authors = paper.authors ?? [];
  if (authors.length === 0) return "Unknown";
  if (authors.length === 1) return authorSurname(authors[0]);
  return `${authorSurname(authors[0])}→${authorSurname(authors[authors.length - 1])}`;
}

export function paperIdentifier(paper: PaperRecord): string {
  if (paper.doi) return `DOI:${paper.doi}`;
  if (paper.pmid) return `PMID:${paper.pmid}`;
  if (paper.pmcid) return `PMCID:${paper.pmcid}`;
  if (paper.zotero_key) return `Zotero:${paper.zotero_key}`;
  return "—";
}

export function sourceLabel(paper: PaperRecord): string {
  const sources = new Set(
    [
      ...(paper.sources ?? []),
      ...(paper.source ? paper.source.split(";") : []),
    ]
      .map((source) => source.trim())
      .filter(Boolean),
  );
  if (sources.has("zotero")) return "ZT";
  if (sources.has("pubmed")) return "PM";
  return "—";
}

export function compactPaperForDisplay(paper: PaperRecord): CompactPaperForDisplay {
  return {
    first_author: firstAuthor(paper),
    title: paper.title,
    id: paperIdentifier(paper),
    source: sourceLabel(paper),
    year: paper.year,
    journal: paper.journal,
  };
}

export function compactPapersForDisplay(papers: PaperRecord[]): CompactPaperForDisplay[] {
  return papers.map(compactPaperForDisplay);
}

function providerLabel(provider: ProviderName): string {
  return provider === "zotero" ? "Zotero" : "PubMed";
}

function providerColor(provider: ProviderName): ThemeColor {
  return provider === "zotero" ? "accent" : "success";
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export function formatFoundLine(
  paper: CompactPaperForDisplay,
  theme?: ThemeLike,
  width = 120,
): string {
  const prefix = `  ${color(theme, "success", "✓ found:")} `;
  if (width < 80) {
    // Stack citation identifiers instead of squeezing them out of a narrow table.
    return `${prefix}${truncateText(paper.first_author, 32)} — ${truncateText(paper.title, 62)}\n    ${color(theme, "muted", displayText(paper.id))}`;
  }
  const author = padText(paper.first_author, 10);
  const title = padText(paper.title, Math.min(62, width - visibleWidth(prefix) - 10 - 28 - 4));
  const id = padText(paper.id, 28);
  return `${prefix}${author}  ${title}  ${color(theme, "muted", id)}`;
}

export function formatPaperPreviewLine(
  paper: CompactPaperForDisplay,
  index: number,
  theme?: ThemeLike,
): string {
  const year = paper.year ? ` ${paper.year}` : "";
  const title = truncateText(paper.title, 88);
  return `  ${color(theme, "success", `${index + 1}.`)} ${truncateText(paper.first_author, 32)}${year} — ${title}`;
}

type RenderOptions = Partial<ToolRenderResultOptions>;

type TextContentResult = { type: string; text?: string };

type ToolRenderResult<TDetails> = {
  content?: TextContentResult[];
  details?: TDetails;
  isError?: boolean;
};

type ProviderSearchSummary = {
  searched?: boolean;
  count?: number;
  query?: string;
  reason?: string;
};

type OutputDisplayDetails = { model_output?: ModelOutputDetails };

type LiteratureResultDetails = OutputDisplayDetails & {
  count?: number;
  papers?: PaperRecord[];
  providers?: {
    pubmed?: ProviderSearchSummary;
    zotero?: ProviderSearchSummary;
  };
  events?: LiteratureSearchDisplayEvent[];
};

type ProviderResultDetails = OutputDisplayDetails & {
  count?: number;
  total?: number;
  papers?: PaperRecord[];
  query?: string;
  params?: { query?: string };
};

function contentText(result: ToolRenderResult<unknown>): string {
  return (result.content ?? []).filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
}

function queryLine(query: string | undefined, theme?: ThemeLike): string[] {
  return query ? [`${color(theme, "muted", "query:")} ${truncateText(query, 96)}`] : [];
}

function failed(result: ToolRenderResult<unknown>, context?: RenderContext): boolean {
  // Interactive Pi passes isError only in context; HTML also includes it in result.
  return Boolean(context?.isError || result.isError);
}

function renderFailure(
  toolName: string,
  result: ToolRenderResult<unknown>,
  options: RenderOptions,
  theme?: ThemeLike,
  query?: string,
  identifier?: string,
): string {
  const prefix = `${color(theme, "error", "!")} ${color(theme, "toolTitle", toolName)} failed`;
  const message = truncateText(contentText(result) || "Tool execution failed", options.expanded ? 1200 : 160);
  if (!options.expanded) return `${prefix}: ${color(theme, "error", message)}`;
  return [
    prefix,
    ...queryLine(query, theme),
    ...(identifier ? [`identifier: ${displayText(identifier)}`] : []),
    color(theme, "error", message),
  ].join("\n");
}

function missingDetails(toolName: string, result: ToolRenderResult<unknown>, options: RenderOptions, theme?: ThemeLike, query?: string): string {
  const lines = [`${color(theme, "muted", "—")} ${color(theme, "toolTitle", toolName)} result details unavailable`];
  if (options.expanded) {
    lines.push(...queryLine(query, theme));
    const text = contentText(result);
    if (text) lines.push(truncateText(text, 800));
  }
  return lines.join("\n");
}

function withOutputNotice(text: string, details: OutputDisplayDetails, options: RenderOptions, theme?: ThemeLike): string {
  if (!details.model_output?.truncated) return text;
  const note = options.expanded
    ? `Model preview truncated; complete JSON: ${displayText(details.model_output.full_result_path)}`
    : " · model preview truncated";
  return `${text}${options.expanded ? "\n" : ""}${color(theme, "warning", note)}`;
}

function literatureCount(details: LiteratureResultDetails): number | undefined {
  return details.count ?? details.papers?.length ?? details.providers?.pubmed?.count;
}

function ownershipWarning(details: LiteratureResultDetails): string | undefined {
  const zotero = details.providers?.zotero;
  if (zotero?.searched === false && zotero.reason && (literatureCount(details) ?? 0) > 0) return zotero.reason;
  return undefined;
}

function renderCollapsedLiteratureResult(details: LiteratureResultDetails, count: number, theme?: ThemeLike): string {
  const prefix = `${color(theme, "success", "✓")} ${color(theme, "toolTitle", "literature_search")}`;
  const summary = count === 0 ? "no PubMed papers found" : `${count} PubMed ${pluralize(count, "paper")}`;
  const zoteroRan = Boolean(details.providers?.zotero?.searched);
  const zoteroMatched = (details.papers ?? []).filter(paper => paper.in_zotero).length;
  const note = zoteroRan && zoteroMatched > 0 ? ` · ${zoteroMatched} already in Zotero` : "";
  const warning = ownershipWarning(details) ? color(theme, "warning", " · Zotero ownership check unavailable") : "";
  return `${prefix} ${summary}${note}${warning}`;
}

function renderLiteratureStreamingStatus(details: LiteratureResultDetails, theme?: ThemeLike): string {
  const event = details.events?.at(-1);
  const prefix = `${color(theme, "accent", "●")} ${color(theme, "toolTitle", "literature_search")}`;
  if (!event || event.phase === "start" || event.phase === "query_start" || event.phase === "dedupe") {
    return `${prefix} searching PubMed…`;
  }
  if (event.phase === "query_error") {
    return `${color(theme, "error", "!")} ${color(theme, "toolTitle", "literature_search")} ${providerLabel(event.provider)} failed: ${truncateText(event.error, 96)}`;
  }
  if (event.phase === "zotero_start") {
    return `${prefix} checking your Zotero library…`;
  }
  if (event.phase === "zotero_progress") {
    return `${prefix} reading Zotero library… ${event.library_items}${event.total ? ` of ~${event.total}` : ""} items`;
  }
  if (event.phase === "zotero_results") {
    return `${prefix} ${event.matched}/${event.total_candidates} candidates already in Zotero`;
  }
  const count = event.count;
  if (count === 0) return `${prefix} no PubMed papers found`;
  return `${prefix} found ${count} PubMed ${pluralize(count, "paper")}`;
}

export function renderLiteratureSearchResult(
  result: ToolRenderResult<LiteratureResultDetails>,
  options: RenderOptions,
  theme?: ThemeLike,
  context?: RenderContext,
): Component {
  return resultComponent(() => {
    const details = result.details ?? {};
    const query = details.providers?.pubmed?.query ?? argument(context, "pubmed_query");
    if (failed(result, context)) return renderFailure("literature_search", result, options, theme, query);
    if (options.isPartial) {
      return [renderLiteratureStreamingStatus(details, theme), ...(options.expanded ? queryLine(query, theme) : [])].join("\n");
    }
    const count = literatureCount(details);
    if (count === undefined) return missingDetails("literature_search", result, options, theme, query);
    const lines = [renderCollapsedLiteratureResult(details, count, theme)];
    if (options.expanded) {
      lines.push(...queryLine(query, theme));
      const papers = details.papers ?? [];
      lines.push(...papers.slice(0, MAX_EXPANDED_PAPER_PREVIEW).map((paper, index) => formatPaperPreviewLine(compactPaperForDisplay(paper), index, theme)));
      const hidden = papers.length - Math.min(papers.length, MAX_EXPANDED_PAPER_PREVIEW);
      if (hidden > 0) lines.push(`  ${color(theme, "dim", "…")} ${hidden} more ${pluralize(hidden, "paper")} in tool result`);
      const warning = ownershipWarning(details);
      if (warning) lines.push(color(theme, "warning", `Zotero ownership check: ${truncateText(warning, 240)}`));
    }
    return withOutputNotice(lines.join("\n"), details, options, theme);
  }, context);
}

export function renderProviderSearchResult(
  provider: ProviderName,
  result: ToolRenderResult<ProviderResultDetails>,
  options: RenderOptions,
  theme?: ThemeLike,
  context?: RenderContext,
): Component {
  return resultComponent(width => {
    const providerName = providerLabel(provider);
    const toolName = provider === "zotero" ? "zotero_search" : "pubmed_search";
    const providerColorName = providerColor(provider);
    const details = result.details ?? {};
    const query = details.query ?? details.params?.query ?? argument(context, "query");
    if (failed(result, context)) return renderFailure(toolName, result, options, theme, query);
    if (options.isPartial) {
      const text = truncateText(contentText(result) || `Searching ${providerName}…`, 240);
      return [`${color(theme, "accent", "●")} ${color(theme, "toolTitle", toolName)} ${color(theme, "warning", text)}`,
        ...(options.expanded ? queryLine(query, theme) : [])].join("\n");
    }
    const count = details.count ?? details.papers?.length;
    if (count === undefined) return missingDetails(toolName, result, options, theme, query);
    if (!options.expanded) {
      return withOutputNotice(`${color(theme, "success", "✓")} ${color(theme, "toolTitle", toolName)} ${count} ${pluralize(count, "paper")}`, details, options, theme);
    }
    const papers = details.papers ?? [];
    const lines = [
      `${color(theme, providerColorName, "→")} ${color(theme, providerColorName, providerName)} q1: ${truncateText(query, 96)}`,
      ...papers.slice(0, MAX_STREAMED_PAPERS_PER_QUERY).map(paper => formatFoundLine(compactPaperForDisplay(paper), theme, width)),
    ];
    const hidden = papers.length - Math.min(papers.length, MAX_STREAMED_PAPERS_PER_QUERY);
    if (hidden > 0) lines.push(`  ${color(theme, "dim", "…")} ${hidden} more candidate papers`);
    lines.push(`${color(theme, "success", "✓")} done: ${count} ${pluralize(count, "paper")}`);
    return withOutputNotice(lines.join("\n"), details, options, theme);
  }, context);
}

const UNAVAILABLE_LABELS: Record<EuropePmcUnavailableReason, string> = {
  not_found: "No exactly matching paper was found",
  ambiguous_match: "More than one matching record; an exact paper is required",
  not_open_access: "The matching paper is not open access",
  no_pmcid: "The matching paper has no usable PMCID",
  xml_not_available: "Open-access full-text XML is not available",
  source_too_large: "Full-text XML exceeds the retrieval size limit",
};

type EuropePmcDisplayDetails = Partial<EuropePmcResult> & OutputDisplayDetails;

function europePmcMetadataLines(details: EuropePmcDisplayDetails, theme?: ThemeLike): string[] {
  const metadata = details.metadata;
  const lines: string[] = [];
  if (metadata?.title) lines.push(bold(theme, truncateText(metadata.title, 160)));
  if (metadata?.author_string) lines.push(truncateText(metadata.author_string, 160));
  if (metadata?.journal || metadata?.year) lines.push(displayText([metadata.journal, metadata.year].filter(Boolean).join(" · ")));
  const ids = [metadata?.doi ? `DOI:${metadata.doi}` : "", metadata?.pmid ? `PMID:${metadata.pmid}` : "", metadata?.pmcid ? `PMCID:${metadata.pmcid}` : ""].filter(Boolean);
  if (ids.length) lines.push(displayText(ids.join(" · ")));
  const provenance = details.provenance;
  if (provenance) {
    lines.push(`provenance: ${displayText(provenance.provider)} · API ${displayText(provenance.api_version)}${metadata ? ` · open access: ${metadata.is_open_access ? "yes" : "no"}` : ""}`);
    if (metadata?.license) lines.push(`license: ${displayText(metadata.license)}`);
    if (provenance.full_text_url) lines.push(`source: ${displayText(provenance.full_text_url)}`);
    lines.push(`search: ${displayText(provenance.search_url)}`);
  }
  return lines;
}

export function renderEuropePmcFulltextResult(
  result: ToolRenderResult<EuropePmcDisplayDetails>,
  options: RenderOptions,
  theme?: ThemeLike,
  context?: RenderContext,
): Component {
  return resultComponent(() => {
    const details = result.details ?? {};
    const identifier = details.identifier?.normalized ?? argument(context, "identifier");
    const name = color(theme, "toolTitle", "europe_pmc_fulltext");
    if (failed(result, context)) return renderFailure("europe_pmc_fulltext", result, options, theme, undefined, identifier);
    if (options.isPartial) {
      return `${color(theme, "accent", "●")} ${name} ${truncateText(contentText(result) || "retrieving open-access excerpts…", 240)}`;
    }
    if (details.status === "unavailable") {
      const lines = [`${color(theme, "warning", "—")} ${name} unavailable: ${displayText(details.reason ?? "unknown")}${identifier ? ` · ${displayText(identifier)}` : ""}`];
      if (options.expanded) {
        if (details.reason) lines.push(UNAVAILABLE_LABELS[details.reason]);
        lines.push(...europePmcMetadataLines(details, theme));
        if (details.recommended_fallback === "pubmed_abstract") lines.push("fallback: PubMed abstract (not fetched)");
      }
      return withOutputNotice(lines.join("\n"), details, options, theme);
    }
    if (details.status !== "full_text") return missingDetails("europe_pmc_fulltext", result, options, theme);
    const sections = details.sections ?? [];
    const summary = sections.length ? `${sections.length} ${pluralize(sections.length, "section")} of open-access excerpts` : "no matching scientific prose";
    const lines = [`${color(theme, "success", "✓")} ${name} ${summary}${details.returned_chars !== undefined ? ` · ${details.returned_chars} chars` : ""}${identifier ? ` · ${displayText(identifier)}` : ""}${details.truncated ? color(theme, "warning", " · truncated") : ""}`];
    if (options.expanded) {
      lines.push(...europePmcMetadataLines(details, theme));
      if (details.requested_sections?.length) lines.push(`requested sections: ${details.requested_sections.join(", ")}`);
      if (details.missing_sections?.length) lines.push(color(theme, "warning", `missing sections: ${details.missing_sections.join(", ")}`));
      if (details.section_fallback) lines.push(color(theme, "warning", "section fallback: using unclassified body prose"));
      if (details.truncated) lines.push(color(theme, "warning", "Returned excerpts are truncated; this is not the complete article."));
      for (const section of sections.slice(0, MAX_EXPANDED_FULLTEXT_SECTIONS)) {
        lines.push(`  ${bold(theme, truncateText(section.heading || section.section, 96))} [${section.section}]${section.truncated ? color(theme, "warning", " (excerpt truncated)") : ""}`);
        lines.push(`  ${truncateText(section.text, MAX_FULLTEXT_PREVIEW_COLUMNS)}`);
      }
      const hidden = Math.max(0, sections.length - MAX_EXPANDED_FULLTEXT_SECTIONS);
      if (hidden) lines.push(`  … ${hidden} more ${pluralize(hidden, "section")} in tool result`);
      if (hidden || sections.some(section => visibleWidth(displayText(section.text)) > MAX_FULLTEXT_PREVIEW_COLUMNS)) {
        lines.push(color(theme, "dim", "UI preview only; complete returned excerpts are in the tool result."));
      }
    }
    return withOutputNotice(lines.join("\n"), details, options, theme);
  }, context);
}
