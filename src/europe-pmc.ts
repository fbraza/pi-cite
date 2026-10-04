import { LITERATURE_TOOL_METADATA } from "./tool-metadata.ts";
import { renderEuropePmcFulltextResult } from "./rendering.ts";
import { Type, type Static } from "typebox";
import {
  emitProgress,
  structuredResult,
  type TextToolUpdate,
} from "./tool-output.ts";

import {
  EUROPE_PMC_OUTPUT,
  EUROPE_PMC_SECTIONS,
  EUROPE_PMC_SECTION_SCHEMA,
  type EuropePmcSection,
  type EuropePmcMetadata,
  type EuropePmcUnavailableReason,
  type EuropePmcUnavailableResult,
  type EuropePmcFulltextResult,
  type EuropePmcResult,
} from "./output-schemas.ts";

export { EUROPE_PMC_SECTIONS } from "./output-schemas.ts";
export type {
  EuropePmcSection,
  EuropePmcUnavailableReason,
  EuropePmcUnavailableResult,
  EuropePmcFulltextResult,
  EuropePmcResult,
} from "./output-schemas.ts";

const EUROPE_PMC_API = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const DEFAULT_MAX_CHARS = 18_000;
const HARD_MAX_CHARS = 24_000;
const MAX_XML_BYTES = 5 * 1024 * 1024;
const SEARCH_PAGE_SIZE = 5;
const MAX_HEADING_CHARS = 200;
const MAX_RETURNED_SECTIONS = 50;

type BodySection = Exclude<EuropePmcSection, "all">;
type Identifier = {
  type: "doi" | "pmid" | "pmcid";
  normalized: string;
  query: string;
};
type EuropePmcRecord = Record<string, unknown>;

export const EUROPE_PMC_FULLTEXT_PARAMS = Type.Object({
  identifier: Type.String({
    description:
      "One DOI (including doi.org URLs), numeric PMID, or PMCID (PMC...).",
  }),
  sections: Type.Optional(
    Type.Array(
      EUROPE_PMC_SECTION_SCHEMA,
      {
        description:
          "Scientific sections to excerpt (default introduction, methods, results, discussion, conclusion).",
      },
    ),
  ),
  max_chars: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: HARD_MAX_CHARS,
      description:
        "Maximum excerpt characters (default 18000, hard maximum 24000).",
    }),
  ),
});

export type EuropePmcFulltextParams = Static<typeof EUROPE_PMC_FULLTEXT_PARAMS>;

function parseEuropePmcInput(
  input: Record<string, unknown>,
): EuropePmcFulltextParams {
  if (typeof input.identifier !== "string" || !input.identifier.trim()) {
    throw new Error("identifier is required and must be a non-empty string");
  }

  let sections: EuropePmcSection[] | undefined;
  if (input.sections !== undefined) {
    if (!Array.isArray(input.sections))
      throw new Error("sections must be an array");
    sections = input.sections.map((section) => {
      if (
        typeof section !== "string" ||
        !EUROPE_PMC_SECTIONS.includes(section as EuropePmcSection)
      ) {
        throw new Error(
          `sections contains unsupported value: ${String(section)}`,
        );
      }
      return section as EuropePmcSection;
    });
    sections = [...new Set(sections)];
    if (sections.includes("all")) sections = ["all"];
  }

  let maxChars: number | undefined;
  if (input.max_chars !== undefined) {
    if (
      typeof input.max_chars !== "number" ||
      !Number.isInteger(input.max_chars)
    ) {
      throw new Error("max_chars must be an integer");
    }
    if (input.max_chars < 1 || input.max_chars > HARD_MAX_CHARS) {
      throw new Error(`max_chars must be between 1 and ${HARD_MAX_CHARS}`);
    }
    maxChars = input.max_chars;
  }

  return { identifier: input.identifier, sections, max_chars: maxChars };
}

export function normalizeEuropePmcIdentifier(value: string): Identifier {
  const input = value.trim();
  const pmcid = input.match(/^(?:PMCID\s*:\s*)?(PMC\d+)$/i);
  if (pmcid) {
    const normalized = pmcid[1]!.toUpperCase();
    return { type: "pmcid", normalized, query: `PMCID:${normalized}` };
  }

  const pmid = input.match(/^(?:PMID\s*:\s*)?(\d+)$/i);
  if (pmid)
    return {
      type: "pmid",
      normalized: pmid[1]!,
      query: `EXT_ID:${pmid[1]} AND SRC:MED`,
    };

  let doi = input
    .replace(/^DOI\s*:\s*/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
  try {
    doi = decodeURIComponent(doi);
  } catch {
    throw new Error(
      "Malformed DOI: identifier contains invalid percent encoding",
    );
  }
  if (/^10\.\d{4,9}\/[-._;()/:a-z0-9]+$/i.test(doi)) {
    const normalized = doi.toLowerCase();
    return { type: "doi", normalized, query: `DOI:${normalized}` };
  }

  throw new Error(
    "Malformed identifier: expected a DOI, doi.org URL, numeric PMID, PMID:<digits>, PMC<digits>, or PMCID:PMC<digits>",
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizedRecordDoi(record: EuropePmcRecord): string | undefined {
  const doi = asString(record.doi);
  if (!doi) return undefined;
  try {
    return normalizeEuropePmcIdentifier(doi).type === "doi"
      ? normalizeEuropePmcIdentifier(doi).normalized
      : undefined;
  } catch {
    return undefined;
  }
}

function recordPmid(record: EuropePmcRecord): string | undefined {
  if (asString(record.source)?.toUpperCase() !== "MED")
    return asString(record.pmid);
  return asString(record.pmid) ?? asString(record.extId) ?? asString(record.id);
}

function recordMatches(
  record: EuropePmcRecord,
  identifier: Identifier,
): boolean {
  if (identifier.type === "doi")
    return normalizedRecordDoi(record) === identifier.normalized;
  if (identifier.type === "pmid") {
    return (
      asString(record.source)?.toUpperCase() === "MED" &&
      recordPmid(record) === identifier.normalized
    );
  }
  return asString(record.pmcid)?.toUpperCase() === identifier.normalized;
}

function recordMetadata(record: EuropePmcRecord): EuropePmcMetadata {
  const journalInfo = record.journalInfo as
    { journal?: { title?: unknown } } | undefined;
  return {
    title: asString(record.title),
    author_string: asString(record.authorString),
    journal:
      asString(journalInfo?.journal?.title) ?? asString(record.journalTitle),
    year: asString(record.pubYear),
    doi: normalizedRecordDoi(record),
    pmid: recordPmid(record),
    pmcid: asString(record.pmcid)?.toUpperCase(),
    license: asString(record.license),
    is_open_access: asString(record.isOpenAccess)?.toUpperCase() === "Y",
  };
}

function unavailable(
  reason: EuropePmcUnavailableReason,
  identifier: Identifier,
  searchUrl: string,
  record?: EuropePmcRecord,
  fullTextUrl?: string,
): EuropePmcUnavailableResult {
  return {
    tool: "europe_pmc_fulltext",
    status: "unavailable",
    reason,
    recommended_fallback: "pubmed_abstract",
    identifier: { type: identifier.type, normalized: identifier.normalized },
    metadata: record ? recordMetadata(record) : undefined,
    provenance: {
      provider: "Europe PMC",
      api_version: "6.9",
      search_url: searchUrl,
      full_text_url: fullTextUrl,
    },
  };
}

async function providerFetch(
  url: string,
  signal: AbortSignal | undefined,
  operation: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      signal,
      headers: {
        accept:
          operation === "search"
            ? "application/json"
            : "application/xml,text/xml",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Europe PMC ${operation} request failed: ${message}`);
  }
  if (response.status === 429)
    throw new Error(
      `Europe PMC ${operation} request was rate limited (HTTP 429); retry later`,
    );
  if (response.status >= 500)
    throw new Error(
      `Europe PMC ${operation} service error (HTTP ${response.status}); retry later`,
    );
  return response;
}

async function readBoundedXml(
  response: Response,
): Promise<{ text?: string; tooLarge: boolean }> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_XML_BYTES) {
    await response.body?.cancel();
    return { tooLarge: true };
  }
  if (!response.body) return { text: "", tooLarge: false };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_XML_BYTES) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), tooLarge: false };
}

const EXCLUDED_JATS = new Set([
  "ref-list",
  "ref",
  "table-wrap",
  "table-wrap-group",
  "table",
  "fig",
  "fig-group",
  "supplementary-material",
  "supplement",
  "app",
  "app-group",
  "media",
  "graphic",
  "ack",
  "fn-group",
]);

function classifyHeading(heading: string): BodySection[] {
  const value = heading
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
  const categories: BodySection[] = [];
  if (/\b(introduction|background)\b/.test(value))
    categories.push("introduction");
  if (
    /\b(methods?|methodology|experimental procedures?|patients? and methods?|materials? and methods?)\b/.test(
      value,
    )
  )
    categories.push("methods");
  if (/\bresults?|findings?\b/.test(value)) categories.push("results");
  if (/\bdiscussion\b/.test(value)) categories.push("discussion");
  if (/\b(conclusions?|concluding remarks?|summary)\b/.test(value))
    categories.push("conclusion");
  return categories;
}

type ExtractedSection = {
  heading: string;
  categories: BodySection[];
  text: string;
};

type SectionBuilder = {
  headingParts: string[];
  categories: BodySection[];
  paragraphs: string[];
};

function decodeXmlText(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(
      /&([a-z]+);/gi,
      (entity, name: string) => named[name.toLowerCase()] ?? entity,
    )
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function findMarkupEnd(xml: string, start: number): number {
  let quote: string | undefined;
  let subsetDepth = 0;
  for (let index = start + 1; index < xml.length; index++) {
    const char = xml[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[") subsetDepth++;
    else if (char === "]" && subsetDepth > 0) subsetDepth--;
    else if (char === ">" && subsetDepth === 0) return index;
  }
  return -1;
}

function parseJats(xml: string): ExtractedSection[] {
  const stack: string[] = [];
  const sections: SectionBuilder[] = [];
  const sectionStack: SectionBuilder[] = [];
  let bodySection: SectionBuilder | undefined;
  let rootSeen = false;
  let bodyCount = 0;
  let inBody = false;
  let excludedDepth = 0;
  let titleOwner: SectionBuilder | undefined;
  const paragraphOwners: SectionBuilder[] = [];
  let paragraphParts: string[] | undefined;

  function appendText(value: string) {
    if (!inBody || excludedDepth > 0) return;
    if (titleOwner) titleOwner.headingParts.push(value);
    if (paragraphParts) paragraphParts.push(value);
  }

  function flushParagraph() {
    if (!paragraphParts) return;
    const text = decodeXmlText(paragraphParts.join(""));
    if (text) paragraphOwners.at(-1)!.paragraphs.push(text);
  }

  function closeParagraph() {
    flushParagraph();
    paragraphOwners.pop();
    paragraphParts = paragraphOwners.length > 0 ? [] : undefined;
  }

  for (let index = 0; index < xml.length;) {
    if (xml.startsWith("<!--", index)) {
      const end = xml.indexOf("-->", index + 4);
      if (end < 0)
        throw new Error(
          "Europe PMC returned unparseable XML: unterminated comment",
        );
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", index)) {
      const end = xml.indexOf("]]>", index + 9);
      if (end < 0)
        throw new Error(
          "Europe PMC returned unparseable XML: unterminated CDATA",
        );
      appendText(xml.slice(index + 9, end));
      index = end + 3;
      continue;
    }
    if (xml[index] !== "<") {
      const end = xml.indexOf("<", index);
      appendText(xml.slice(index, end < 0 ? xml.length : end));
      index = end < 0 ? xml.length : end;
      continue;
    }

    const end = findMarkupEnd(xml, index);
    if (end < 0)
      throw new Error("Europe PMC returned unparseable XML: unterminated tag");
    const markup = xml.slice(index + 1, end).trim();
    index = end + 1;
    if (!markup || markup.startsWith("?") || markup.startsWith("!")) continue;

    const closing = markup.startsWith("/");
    const selfClosing = !closing && markup.endsWith("/");
    const name = (closing ? markup.slice(1) : markup)
      .match(/^([A-Za-z_][\w:.-]*)/)?.[1]
      ?.toLowerCase();
    if (!name)
      throw new Error("Europe PMC returned unparseable XML: invalid tag");

    if (closing) {
      const opened = stack.pop();
      if (opened !== name)
        throw new Error(
          `Europe PMC returned unparseable XML: expected </${opened ?? "none"}> before </${name}>`,
        );
      if (name === "p" && excludedDepth === 0) closeParagraph();
      if (name === "title" && titleOwner) {
        const heading = decodeXmlText(titleOwner.headingParts.join(""));
        const ownCategories = classifyHeading(heading);
        titleOwner.categories =
          ownCategories.length > 0
            ? ownCategories
            : (sectionStack.at(-2)?.categories ?? []);
        titleOwner = undefined;
      }
      if (name === "sec" && inBody && excludedDepth === 0) sectionStack.pop();
      if (EXCLUDED_JATS.has(name) && excludedDepth > 0) excludedDepth--;
      if (name === "body" && stack.length === 1) inBody = false;
      continue;
    }

    if (stack.length === 0) {
      if (rootSeen || name !== "article") {
        throw new Error(
          "Europe PMC returned malformed full-text XML: expected a single JATS article root",
        );
      }
      rootSeen = true;
    }
    stack.push(name);
    if (name === "body" && stack.length === 2) {
      bodyCount++;
      inBody = true;
    }
    if (inBody && EXCLUDED_JATS.has(name)) excludedDepth++;
    if (inBody && excludedDepth === 0 && name === "sec") {
      bodySection = undefined;
      const section: SectionBuilder = {
        headingParts: [],
        categories: sectionStack.at(-1)?.categories ?? [],
        paragraphs: [],
      };
      sections.push(section);
      sectionStack.push(section);
    }
    if (
      inBody &&
      excludedDepth === 0 &&
      name === "title" &&
      stack.at(-2) === "sec"
    )
      titleOwner = sectionStack.at(-1);
    if (inBody && excludedDepth === 0 && name === "p") {
      flushParagraph();
      let owner = sectionStack.at(-1);
      if (!owner) {
        if (!bodySection) {
          bodySection = {
            headingParts: ["Article body"],
            categories: [],
            paragraphs: [],
          };
          sections.push(bodySection);
        }
        owner = bodySection;
      }
      paragraphOwners.push(owner);
      paragraphParts = [];
    }
    if (selfClosing) {
      stack.pop();
      if (name === "p" && excludedDepth === 0) closeParagraph();
      if (name === "title" && titleOwner) titleOwner = undefined;
      if (name === "sec" && inBody && excludedDepth === 0) sectionStack.pop();
      if (EXCLUDED_JATS.has(name) && excludedDepth > 0) excludedDepth--;
      if (name === "body" && stack.length === 1) inBody = false;
    }
  }

  if (stack.length > 0)
    throw new Error(
      `Europe PMC returned unparseable XML: unclosed <${stack.at(-1)}> tag`,
    );
  if (bodyCount !== 1)
    throw new Error(
      "Europe PMC returned malformed full-text XML: expected exactly one article body",
    );
  const extracted = sections
    .map((section) => ({
      heading:
        decodeXmlText(section.headingParts.join("")) || "Untitled section",
      categories: section.categories,
      text: section.paragraphs.join("\n\n"),
    }))
    .filter((section) => section.text);
  if (extracted.length === 0)
    throw new Error(
      "Europe PMC returned malformed full-text XML: article body has no readable prose",
    );
  return extracted;
}

function selectAndBoundSections(
  extracted: ExtractedSection[],
  requested: EuropePmcSection[],
  maxChars: number,
  allowFallback: boolean,
): Pick<
  EuropePmcFulltextResult,
  | "sections"
  | "missing_sections"
  | "section_fallback"
  | "truncated"
  | "returned_chars"
> {
  const all = requested.includes("all");
  const requestedBody = requested.filter(
    (section): section is BodySection => section !== "all",
  );
  let matching = extracted.filter(
    (section) =>
      all ||
      section.categories.some((category) => requestedBody.includes(category)),
  );
  const present = new Set(matching.flatMap((section) => section.categories));
  const missing = all
    ? []
    : requestedBody.filter((section) => !present.has(section));
  const sectionFallback = allowFallback && matching.length === 0;
  if (sectionFallback) matching = extracted;
  let remaining = maxChars;
  let truncated = matching.length > MAX_RETURNED_SECTIONS;
  matching = matching.slice(0, MAX_RETURNED_SECTIONS);
  const sections: EuropePmcFulltextResult["sections"] = [];
  for (const [index, item] of matching.entries()) {
    if (remaining === 0) {
      truncated = true;
      break;
    }
    const allocation = Math.max(
      1,
      Math.floor(remaining / (matching.length - index)),
    );
    const text = item.text.slice(0, allocation);
    const heading = item.heading.slice(0, MAX_HEADING_CHARS);
    const itemTruncated =
      text.length < item.text.length || heading.length < item.heading.length;
    const selectedCategory =
      item.categories.find(
        (category) => all || requestedBody.includes(category),
      ) ?? "other";
    sections.push({
      section: selectedCategory,
      heading,
      text,
      truncated: itemTruncated,
    });
    remaining -= text.length;
    if (itemTruncated) truncated = true;
  }
  return {
    sections,
    missing_sections: missing,
    section_fallback: sectionFallback,
    truncated,
    returned_chars: maxChars - remaining,
  };
}

export async function fetchEuropePmcFulltext(
  params: EuropePmcFulltextParams,
  signal?: AbortSignal,
  onUpdate?: TextToolUpdate,
): Promise<EuropePmcResult> {
  params = parseEuropePmcInput(params);
  const identifier = normalizeEuropePmcIdentifier(params.identifier);
  const requested: EuropePmcSection[] = params.sections?.length
    ? params.sections
    : ["introduction", "methods", "results", "discussion", "conclusion"];
  const maxChars = params.max_chars ?? DEFAULT_MAX_CHARS;
  const searchUrl = new URL(`${EUROPE_PMC_API}/search`);
  searchUrl.searchParams.set("query", identifier.query);
  searchUrl.searchParams.set("resultType", "core");
  searchUrl.searchParams.set("format", "json");
  searchUrl.searchParams.set("pageSize", String(SEARCH_PAGE_SIZE));

  emitProgress(
    onUpdate,
    `Resolving Europe PMC paper: ${identifier.normalized}`,
  );
  const searchResponse = await providerFetch(
    searchUrl.toString(),
    signal,
    "search",
  );
  if (searchResponse.status === 404)
    return unavailable("not_found", identifier, searchUrl.toString());
  if (!searchResponse.ok)
    throw new Error(
      `Europe PMC search request failed (HTTP ${searchResponse.status})`,
    );
  let payload: unknown;
  try {
    payload = await searchResponse.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Europe PMC returned malformed search JSON: ${message}`);
  }
  if (!payload || typeof payload !== "object")
    throw new Error("Europe PMC returned malformed search payload");
  const searchPayload = payload as Record<string, unknown>;
  const hitCount = Number(searchPayload.hitCount);
  if (!Number.isInteger(hitCount) || hitCount < 0)
    throw new Error(
      "Europe PMC returned malformed search payload: invalid hitCount",
    );
  const resultList = searchPayload.resultList;
  if (!resultList || typeof resultList !== "object")
    throw new Error(
      "Europe PMC returned malformed search payload: missing resultList",
    );
  const records = (resultList as Record<string, unknown>).result;
  if (records === undefined) {
    if (hitCount === 0)
      return unavailable("not_found", identifier, searchUrl.toString());
    throw new Error(
      "Europe PMC returned malformed search payload: missing results for nonzero hitCount",
    );
  }
  if (
    !Array.isArray(records) ||
    records.some((record) => !record || typeof record !== "object")
  ) {
    throw new Error(
      "Europe PMC returned malformed search payload: result must be an array",
    );
  }
  if (hitCount > records.length)
    return unavailable("ambiguous_match", identifier, searchUrl.toString());
  const matches = (records as EuropePmcRecord[]).filter((record) =>
    recordMatches(record, identifier),
  );
  if (matches.length === 0)
    return unavailable("not_found", identifier, searchUrl.toString());
  if (matches.length !== 1)
    return unavailable("ambiguous_match", identifier, searchUrl.toString());
  const record = matches[0]!;
  if (asString(record.isOpenAccess)?.toUpperCase() !== "Y")
    return unavailable(
      "not_open_access",
      identifier,
      searchUrl.toString(),
      record,
    );
  const pmcid = asString(record.pmcid)?.toUpperCase();
  if (!pmcid || !/^PMC\d+$/.test(pmcid))
    return unavailable("no_pmcid", identifier, searchUrl.toString(), record);

  const fullTextUrl = `${EUROPE_PMC_API}/${pmcid}/fullTextXML`;
  emitProgress(
    onUpdate,
    `Retrieving Europe PMC open-access full text: ${pmcid}`,
  );
  const xmlResponse = await providerFetch(fullTextUrl, signal, "full-text");
  if (xmlResponse.status === 404)
    return unavailable(
      "xml_not_available",
      identifier,
      searchUrl.toString(),
      record,
      fullTextUrl,
    );
  if (!xmlResponse.ok)
    throw new Error(
      `Europe PMC full-text request failed (HTTP ${xmlResponse.status})`,
    );
  const raw = await readBoundedXml(xmlResponse);
  if (raw.tooLarge)
    return unavailable(
      "source_too_large",
      identifier,
      searchUrl.toString(),
      record,
      fullTextUrl,
    );
  const extracted = parseJats(raw.text ?? "");
  const bounded = selectAndBoundSections(
    extracted,
    requested,
    maxChars,
    params.sections === undefined,
  );
  const doi = normalizedRecordDoi(record);
  return {
    tool: "europe_pmc_fulltext",
    status: "full_text",
    identifier: { type: identifier.type, normalized: identifier.normalized },
    metadata: recordMetadata(record),
    ...bounded,
    requested_sections: requested,
    max_chars: maxChars,
    provenance: {
      provider: "Europe PMC",
      api_version: "6.9",
      search_url: searchUrl.toString(),
      full_text_url: fullTextUrl,
    },
    urls: {
      europe_pmc: `https://europepmc.org/article/${encodeURIComponent(asString(record.source) ?? "PMC")}/${encodeURIComponent(asString(record.id) ?? asString(record.extId) ?? pmcid)}`,
      doi: doi ? `https://doi.org/${doi}` : undefined,
      pmc: `https://europepmc.org/articles/${pmcid}`,
    },
  };
}

export function createEuropePmcFulltextTool() {
  return {
    ...LITERATURE_TOOL_METADATA,
    name: "europe_pmc_fulltext",
    label: "Europe PMC Full Text",
    description:
      "Retrieve bounded Europe PMC open-access excerpts by DOI, PMID, or PMCID, with provenance and availability.",
    parameters: EUROPE_PMC_FULLTEXT_PARAMS,
    outputSchema: EUROPE_PMC_OUTPUT,
    async execute(
      _toolCallId: string,
      params: EuropePmcFulltextParams,
      signal?: AbortSignal,
      onUpdate?: TextToolUpdate,
    ) {
      const result = await fetchEuropePmcFulltext(params, signal, onUpdate);
      return structuredResult(EUROPE_PMC_OUTPUT, JSON.stringify(result, null, 2), result, result);
    },
    renderResult(
      result: Parameters<typeof renderEuropePmcFulltextResult>[0],
      options: Parameters<typeof renderEuropePmcFulltextResult>[1],
      theme: Parameters<typeof renderEuropePmcFulltextResult>[2],
      context?: Parameters<typeof renderEuropePmcFulltextResult>[3],
    ) {
      return renderEuropePmcFulltextResult(result, options, theme, context);
    },
  };
}
