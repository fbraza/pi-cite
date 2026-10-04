import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Static, TSchema } from "typebox";
import { structuredResult, textBlock } from "./tool-output.ts";

export const MAX_MODEL_OUTPUT_BYTES = 32 * 1024;

// Do not turn citation IDs, source URLs, or warnings into plausible-looking shortened values.
const VERBATIM_METADATA = new Set([
  "pmid", "pmcid", "doi", "zotero_key", "source", "normalized", "license", "reason",
  "search_url", "full_text_url", "europe_pmc", "pmc",
]);

export type ModelOutputDetails = {
  truncated: true;
  max_bytes: number;
  original_bytes: number;
  full_result_bytes: number;
  full_result_path: string;
  total_papers?: number;
  shown_papers?: number;
  total_sections?: number;
  shown_sections?: number;
};

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Request aborted");
}

/** Cut only at a UTF-8 code-point boundary. JSON serialization is measured separately. */
function excerpt(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes - Buffer.byteLength("…");
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + "…";
}

function project(value: unknown, maxBytes: number, field?: string): unknown {
  if (typeof value === "string") {
    if (field && VERBATIM_METADATA.has(field)) {
      return Buffer.byteLength(JSON.stringify(value), "utf8") <= 1024
        ? value
        : { omitted: true, retrieval: "Read this field verbatim from the complete JSON artifact." };
    }
    return excerpt(value, maxBytes);
  }
  if (Array.isArray(value)) return value.slice(0, 8).map(item => project(item, maxBytes));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, project(item, maxBytes, key)]));
  }
  return value;
}

function paperPreview(paper: Record<string, unknown>, fieldBytes: number, proseBytes: number) {
  const { abstract, ...metadata } = paper;
  return {
    ...(project(metadata, fieldBytes) as Record<string, unknown>),
    ...(typeof abstract === "string" ? { abstract_excerpt: excerpt(abstract, proseBytes) } : {}),
  };
}

function sectionPreview(section: Record<string, unknown>, fieldBytes: number, proseBytes: number) {
  const { text, ...metadata } = section;
  return {
    ...(project(metadata, fieldBytes) as Record<string, unknown>),
    ...(typeof text === "string" ? { text_excerpt: excerpt(text, proseBytes) } : {}),
  };
}

/** Valid JSON evidence previews, never a raw byte slice of a paper array or scientific excerpt. */
export function buildModelPreview(data: Record<string, unknown>, output: ModelOutputDetails): string {
  const { papers, sections, ...metadata } = data;
  const records = (Array.isArray(papers) ? papers : Array.isArray(sections) ? sections : []) as Record<string, unknown>[];
  const listName = Array.isArray(papers) ? "paper_previews" : "section_previews";
  const previewRecord = Array.isArray(papers) ? paperPreview : sectionPreview;
  const serialize = (value: unknown) => JSON.stringify(value, null, 2);
  const fits = (value: unknown) => Buffer.byteLength(serialize(value), "utf8") <= MAX_MODEL_OUTPUT_BYTES;
  // Lower limits only for unusually large metadata or JSON-escaped control characters.
  for (const [fieldBytes, proseBytes] of [[256, 4096], [64, 1024], [16, 256]]) {
    const entries: unknown[] = [];
    const preview = {
      model_output: {
        ...output,
        notice: "Incomplete model preview: abstracts/prose are excerpts; long metadata fields and arrays may be shortened. Oversized identifiers/source URLs/warnings are explicitly omitted, not shortened. Read the complete result before citing omitted fields or making claims from incomplete evidence.",
        retrieval: "Use the read tool on full_result_path (with offset/limit), or parse that JSON file with bash to select complete papers/sections. The file contains the complete structured result, not UI details. Copy it into your review folder for durable retention; temporary files may be removed by the OS or explicitly deleted.",
      },
      result_metadata: project(metadata, fieldBytes),
      [listName]: entries,
    };
    if (!fits(preview)) continue;
    for (const record of records) {
      entries.push(previewRecord(record, fieldBytes, proseBytes));
      if (!fits(preview)) { entries.pop(); break; }
    }
    if (records.length && entries.length === 0) continue;
    if (Array.isArray(papers)) preview.model_output.shown_papers = entries.length;
    else if (Array.isArray(sections)) preview.model_output.shown_sections = entries.length;
    if (fits(preview)) return serialize(preview);
  }
  throw new Error("Could not build an evidence preview within the model output budget");
}

/** Successful artifacts outlive sessions; only failed/cancelled writes are automatically removed. */
export async function writeEvidenceArtifact(data: unknown, { signal, artifactRoot = tmpdir() }: { signal?: AbortSignal; artifactRoot?: string } = {}): Promise<{ path: string; bytes: number }> {
  checkAbort(signal);
  const text = JSON.stringify(data, null, 2);
  const directory = await fs.mkdtemp(join(artifactRoot, "pi-cite-evidence-"));
  try {
    checkAbort(signal);
    const path = join(directory, "result.json");
    await fs.writeFile(path, text, { encoding: "utf8", mode: 0o600, flag: "wx", signal });
    checkAbort(signal);
    return { path, bytes: Buffer.byteLength(text, "utf8") };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function evidenceResult<TOutput extends TSchema, TDetails extends Record<string, unknown>>(
  schema: TOutput,
  text: string,
  data: Static<TOutput>,
  details: TDetails,
  options: { signal?: AbortSignal; artifactRoot?: string } = {},
) {
  checkAbort(options.signal);
  const result = structuredResult(schema, text, data, details);
  const record = result.structuredContent as Record<string, unknown>;
  const providers = record.providers as Record<string, { searched?: boolean; reason?: string }> | undefined;
  const warnings = Object.entries(providers ?? {})
    .filter(([, provider]) => provider.searched === false && provider.reason)
    .map(([name, provider]) => `${name}: ${provider.reason}`);
  if (warnings.length) result.content.push(textBlock(`Provider warnings: ${warnings.join("; ")}`));
  const originalBytes = result.content.reduce((sum, block) => sum + Buffer.byteLength(block.text, "utf8"), 0);
  if (originalBytes <= MAX_MODEL_OUTPUT_BYTES) return result;
  const artifact = await writeEvidenceArtifact(result.structuredContent, options);
  try {
    const output: ModelOutputDetails = {
      truncated: true, max_bytes: MAX_MODEL_OUTPUT_BYTES, original_bytes: originalBytes,
      full_result_bytes: artifact.bytes, full_result_path: artifact.path,
      ...(Array.isArray(record.papers) ? { total_papers: record.papers.length } : {}),
      ...(Array.isArray(record.sections) ? { total_sections: record.sections.length } : {}),
    };
    const preview = buildModelPreview(record, output);
    const shown = JSON.parse(preview).model_output as ModelOutputDetails;
    checkAbort(options.signal);
    return { ...result, content: [textBlock(preview)], details: { ...details, model_output: shown } };
  } catch (error) {
    await fs.rm(dirname(artifact.path), { recursive: true, force: true });
    throw error;
  }
}
