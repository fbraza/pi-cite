import { Text } from "@earendil-works/pi-tui";
import type { PaperRecord } from "./types.ts";

export const MAX_STREAMED_PAPERS_PER_QUERY = 5;
export const MAX_FINAL_MERGED_PAPERS = 20;

type ThemeLike = {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
};

export type CompactPaperForDisplay = {
  first_author: string;
  title: string;
  id: string;
  source: string;
  year?: number;
  journal?: string;
};

export type LiteratureSearchDisplayEvent =
  | { phase: "start" }
  | {
      phase: "query_start";
      provider: "pubmed";
      query_index: number;
      query: string;
    }
  | {
      phase: "query_results";
      provider: "pubmed";
      query_index: number;
      query: string;
      count: number;
      papers: CompactPaperForDisplay[];
    }
  | {
      phase: "query_error";
      provider: "pubmed";
      query_index: number;
      query: string;
      error: string;
    }
  | { phase: "dedupe" }
  | { phase: "complete"; count: number; papers: CompactPaperForDisplay[] };

export type LiteratureSearchDisplaySearch = {
  provider: "pubmed";
  query_index: number;
  query: string;
  count: number;
  papers: CompactPaperForDisplay[];
};

function terminalText(text: string): Text {
  return new Text(text, 0, 0);
}

function color(theme: ThemeLike | undefined, colorName: string, text: string): string {
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

export function truncateText(value: unknown, maxLength: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function padText(value: unknown, width: number): string {
  const text = truncateText(value, width);
  return text + " ".repeat(Math.max(0, width - text.length));
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
  if (sources.has("pubmed")) return "PM";
  return paper.source ?? "—";
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

function providerLabel(provider: "pubmed"): string {
  return "PubMed";
}

function providerColor(provider: "pubmed"): string {
  return "success";
}

export function formatFoundLine(
  paper: CompactPaperForDisplay,
  theme?: ThemeLike,
): string {
  const author = padText(paper.first_author, 10);
  const title = padText(paper.title, 62);
  const id = padText(paper.id, 28);
  return `  ${color(theme, "success", "✓ found:")} ${author}  ${title}  ${color(theme, "muted", id)}`;
}

export function formatMergedLine(
  paper: CompactPaperForDisplay,
  index: number,
  theme?: ThemeLike,
): string {
  const title = truncateText(paper.title, 72);
  const source = color(theme, "success", `(${paper.source})`);
  return `  ${color(theme, "success", "+")} ${index + 1}. ${title} ${source}`;
}

function renderEvent(
  event: LiteratureSearchDisplayEvent,
  theme?: ThemeLike,
): string[] {
  if (event.phase === "start") {
    return [`${color(theme, "accent", "●")} ${color(theme, "toolTitle", "literature_search")} starting`];
  }
  if (event.phase === "query_start") {
    return [
      `${color(theme, providerColor(event.provider), "→")} ${color(theme, providerColor(event.provider), providerLabel(event.provider))} q${event.query_index}: ${event.query}`,
    ];
  }
  if (event.phase === "query_results") {
    const lines = event.papers
      .slice(0, MAX_STREAMED_PAPERS_PER_QUERY)
      .map((paper) => formatFoundLine(paper, theme));
    const hidden = event.count - Math.min(event.count, MAX_STREAMED_PAPERS_PER_QUERY);
    if (hidden > 0) lines.push(`  ${color(theme, "dim", "…")} ${hidden} more candidate papers`);
    if (event.count === 0) lines.push(`  ${color(theme, "muted", "no candidate papers found")}`);
    return lines;
  }
  if (event.phase === "query_error") {
    return [
      `  ${color(theme, "error", "! failed:")} ${providerLabel(event.provider)} q${event.query_index}: ${truncateText(event.error, 96)}`,
    ];
  }
  if (event.phase === "dedupe") {
    return [`${color(theme, "warning", "→")} deduplicating by DOI / PMID / title-year`];
  }
  const lines = event.papers
    .slice(0, MAX_FINAL_MERGED_PAPERS)
    .map((paper, index) => formatMergedLine(paper, index, theme));
  const hidden = event.count - Math.min(event.count, MAX_FINAL_MERGED_PAPERS);
  if (hidden > 0) lines.push(`  ${color(theme, "dim", "…")} ${hidden} more merged papers`);
  lines.push(`${color(theme, "success", "✓")} done: ${event.count} merged papers`);
  return lines;
}

export function renderLiteratureEventTranscript(
  events: LiteratureSearchDisplayEvent[] | undefined,
  theme?: ThemeLike,
): string {
  if (!events?.length) return "";
  return events.flatMap((event) => renderEvent(event, theme)).join("\n");
}

type RenderOptions = { expanded?: boolean; isPartial?: boolean };

type TextContentResult = { type: string; text?: string };

type ToolRenderResult<TDetails> = {
  content?: TextContentResult[];
  details?: TDetails;
};

type ProviderSearchSummary = {
  searched?: boolean;
  count?: number;
};

type LiteratureResultDetails = {
  count?: number;
  papers?: PaperRecord[];
  providers?: {
    pubmed?: ProviderSearchSummary;
  };
  events?: LiteratureSearchDisplayEvent[];
};

type ProviderResultDetails = {
  papers?: PaperRecord[];
  query?: string;
  params?: { query?: string };
};

function renderCollapsedLiteratureResult(details: LiteratureResultDetails, theme?: ThemeLike): string {
  const pubmed = details?.providers?.pubmed;
  const pubmedText = pubmed?.searched ? `PubMed: ${pubmed.count}` : "PubMed: —";
  const count = details?.count ?? details?.papers?.length ?? 0;
  return `${color(theme, "success", "✓")} ${color(theme, "toolTitle", "literature_search")} ${color(theme, "success", pubmedText)} | merged: ${count}`;
}

export function renderLiteratureSearchResult(
  result: ToolRenderResult<LiteratureResultDetails>,
  options: RenderOptions,
  theme?: ThemeLike,
): Text {
  const details = result.details ?? {};
  const transcript = renderLiteratureEventTranscript(details.events, theme);
  if (options.isPartial) {
    return terminalText(transcript || color(theme, "warning", "Searching literature..."));
  }
  if (!options.expanded) {
    return terminalText(renderCollapsedLiteratureResult(details, theme));
  }
  if (transcript) return terminalText(transcript);

  const papers = compactPapersForDisplay(details.papers ?? []);
  const lines = [
    `${color(theme, "accent", "●")} ${color(theme, "toolTitle", "literature_search")} result`,
    renderCollapsedLiteratureResult(details, theme),
    `${color(theme, "warning", "→")} deduplicating by DOI / PMID / title-year`,
    ...papers.slice(0, MAX_FINAL_MERGED_PAPERS).map((paper, index) => formatMergedLine(paper, index, theme)),
    `${color(theme, "success", "✓")} done: ${papers.length} merged papers`,
  ];
  return terminalText(lines.join("\n"));
}

export function renderProviderSearchResult(
  provider: "pubmed",
  result: ToolRenderResult<ProviderResultDetails>,
  options: RenderOptions,
  theme?: ThemeLike,
): Text {
  const providerName = providerLabel(provider);
  const details = result.details ?? {};
  const papers = compactPapersForDisplay(details.papers ?? []);
  const query = details.query ?? details.params?.query ?? "";
  if (options.isPartial) {
    const text = result.content?.[0]?.type === "text" ? result.content[0].text ?? "" : `Searching ${providerName}...`;
    return terminalText(color(theme, "warning", text));
  }
  if (!options.expanded) {
    return terminalText(`${color(theme, "success", "✓")} ${color(theme, "toolTitle", "pubmed_search")} ${papers.length} papers`);
  }
  const lines = [
    `${color(theme, providerColor(provider), "→")} ${color(theme, providerColor(provider), providerName)} q1: ${query}`,
    ...papers.slice(0, MAX_STREAMED_PAPERS_PER_QUERY).map((paper) => formatFoundLine(paper, theme)),
  ];
  const hidden = papers.length - Math.min(papers.length, MAX_STREAMED_PAPERS_PER_QUERY);
  if (hidden > 0) lines.push(`  ${color(theme, "dim", "…")} ${hidden} more candidate papers`);
  lines.push(`${color(theme, "success", "✓")} done: ${papers.length} papers`);
  return terminalText(lines.join("\n"));
}
