import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PaperRecord } from "./types.ts";

export const USER_AGENT = "research-skills-literature-tools/0.1 (+https://github.com/fbraza/research-skills)";

export function unique<T>(items: T[]): T[] {
	return [...new Set(items.filter((item) => item !== undefined && item !== null && item !== ""))];
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(resolve, ms);
		if (!signal) return;
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Request aborted"));
		};
		if (signal.aborted) onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export function htmlDecode(text: string): string {
	return text
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function normalizeDoi(raw?: string): string | undefined {
	if (!raw) return undefined;
	return raw
		.trim()
		.replace(/^doi:\s*/i, "")
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
		.trim() || undefined;
}

export function xmlDecode(text: string): string {
	return htmlDecode(text);
}

export function pickAll(regex: RegExp, text: string): string[] {
	const matches: string[] = [];
	for (const match of text.matchAll(regex)) {
		if (match[1]) matches.push(xmlDecode(match[1]));
	}
	return matches;
}

export function pickOne(regex: RegExp, text: string): string | undefined {
	const match = regex.exec(text);
	return match?.[1] ? xmlDecode(match[1]) : undefined;
}

export async function fetchText(url: string, signal?: AbortSignal, headers?: Record<string, string>): Promise<string> {
	const response = await fetch(url, {
		headers: {
			"user-agent": USER_AGENT,
			accept: "application/json, text/xml, application/xml, text/html;q=0.9, */*;q=0.8",
			...headers,
		},
		signal,
		redirect: "follow",
	});
	if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
	return await response.text();
}

export async function fetchJson<T>(url: string, signal?: AbortSignal, headers?: Record<string, string>): Promise<T> {
	const text = await fetchText(url, signal, headers);
	return JSON.parse(text) as T;
}

export function formatPaperText(papers: PaperRecord[]): string {
	return JSON.stringify(papers, null, 2);
}

export function sanitizeFilename(value: string): string {
	return value.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "paper";
}

export async function savePdf(pdfUrl: string, outputDir: string, preferredId: string, signal?: AbortSignal): Promise<string> {
	await mkdir(outputDir, { recursive: true });
	const response = await fetch(pdfUrl, {
		method: "GET",
		signal,
		headers: { "user-agent": USER_AGENT, accept: "application/pdf,*/*" },
		redirect: "follow",
	});
	if (!response.ok) throw new Error(`Failed to download PDF (${response.status})`);
	const bytes = Buffer.from(await response.arrayBuffer());
	const filePath = path.resolve(outputDir, `${sanitizeFilename(preferredId)}.pdf`);
	await writeFile(filePath, bytes);
	return filePath;
}
