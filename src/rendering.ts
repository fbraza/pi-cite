import { Text } from "@earendil-works/pi-tui";
import type { PaperRecord } from "./types.ts";

export const MAX_STREAMED_PAPERS_PER_QUERY = 5;
export const MAX_EXPANDED_PAPER_PREVIEW = 5;

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
    }
  | {
      phase: "query_error";
      provider: "pubmed";
      query_index: number;
      query: string;
      error: string;
    }
  | { phase: "dedupe" }
  | { phase: "complete"; count: number };

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

function providerLabel(provider: "pubmed"): string {
  return "PubMed";
}

function providerColor(provider: "pubmed"): string {
  return "success";
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
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

export function formatPaperPreviewLine(
  paper: CompactPaperForDisplay,
  index: number,
  theme?: ThemeLike,
): string {
  const year = paper.year ? ` ${paper.year}` : "";
  const title = truncateText(paper.title, 88);
  return `  ${color(theme, "success", `${index + 1}.`)} ${paper.first_author}${year} — ${title}`;
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
  query?: string;
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
  const count = details.count ?? details.papers?.length ?? details.providers?.pubmed?.count;
  const prefix = `${color(theme, "success", "✓")} ${color(theme, "toolTitle", "literature_search")}`;
  if (count === undefined) return `${prefix} PubMed papers`;
  if (count === 0) return `${prefix} no PubMed papers found`;
  return `${prefix} ${count} PubMed ${pluralize(count, "paper")}`;
}

function renderLiteratureStreamingStatus(details: LiteratureResultDetails, theme?: ThemeLike): string {
  const event = details.events?.at(-1);
  const prefix = `${color(theme, "accent", "●")} ${color(theme, "toolTitle", "literature_search")}`;
  if (!event || event.phase === "start" || event.phase === "query_start" || event.phase === "dedupe") {
    return `${prefix} searching PubMed…`;
  }
  if (event.phase === "query_error") {
    return `${color(theme, "error", "!")} ${color(theme, "toolTitle", "literature_search")} PubMed failed: ${truncateText(event.error, 96)}`;
  }
  const count = event.count;
  if (count === 0) return `${prefix} no PubMed papers found`;
  return `${prefix} found ${count} PubMed ${pluralize(count, "paper")}`;
}

function renderExpandedLiteratureResult(details: LiteratureResultDetails, theme?: ThemeLike): string {
  const papers = compactPapersForDisplay(details.papers ?? []);
  const lines = [renderCollapsedLiteratureResult(details, theme)];
  const query = details.providers?.pubmed?.query;
  if (query) lines.push(`${color(theme, "muted", "query:")} ${truncateText(query, 96)}`);
  lines.push(
    ...papers
      .slice(0, MAX_EXPANDED_PAPER_PREVIEW)
      .map((paper, index) => formatPaperPreviewLine(paper, index, theme)),
  );
  const hidden = papers.length - Math.min(papers.length, MAX_EXPANDED_PAPER_PREVIEW);
  if (hidden > 0) lines.push(`  ${color(theme, "dim", "…")} ${hidden} more ${pluralize(hidden, "paper")} in tool result`);
  return lines.join("\n");
}

export function renderLiteratureSearchResult(
  result: ToolRenderResult<LiteratureResultDetails>,
  options: RenderOptions,
  theme?: ThemeLike,
): Text {
  const details = result.details ?? {};
  if (options.isPartial) {
    return terminalText(renderLiteratureStreamingStatus(details, theme));
  }
  if (!options.expanded) {
    return terminalText(renderCollapsedLiteratureResult(details, theme));
  }
  return terminalText(renderExpandedLiteratureResult(details, theme));
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
