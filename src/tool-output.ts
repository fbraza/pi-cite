import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

export type TextToolBlock = {
	type: "text";
	text: string;
};

export type TextToolPayload<TDetails extends Record<string, unknown> = Record<string, unknown>> =
	Pick<AgentToolResult<TDetails>, "details" | "isError"> & { content: TextToolBlock[] };

export type TextToolUpdate<TDetails extends Record<string, unknown> = Record<string, unknown>> = (
	update: TextToolPayload<TDetails>,
) => void;

export function textBlock(text: string): TextToolBlock {
	return { type: "text", text };
}

export function textResult<TDetails extends Record<string, unknown> = Record<string, unknown>>(
	text: string,
	details?: TDetails,
): TextToolPayload<TDetails> {
	return {
		content: [textBlock(text)],
		details: (details ?? {}) as TDetails,
	};
}

export type StructuredToolPayload<TData, TDetails extends Record<string, unknown>> = TextToolPayload<TDetails> & {
	structuredContent: TData;
};

/** Final data result; partial progress does not need to satisfy the output schema. */
export function structuredResult<TOutput extends TSchema, TDetails extends Record<string, unknown>>(
	schema: TOutput,
	text: string,
	data: Static<TOutput>,
	details: TDetails,
): StructuredToolPayload<Static<TOutput>, TDetails> {
	// Omit optional undefined fields without changing the provider's data or UI details.
	const structuredContent: unknown = JSON.parse(JSON.stringify(data));
	if (!Value.Check(schema, structuredContent)) {
		throw new Error("Tool returned data that does not match its output schema");
	}
	return {
		...textResult(text, details),
		structuredContent,
	};
}

export function errorResult<TDetails extends Record<string, unknown> = Record<string, unknown>>(
	text: string,
	details?: TDetails,
): TextToolPayload<TDetails> {
	return {
		content: [textBlock(text)],
		details: (details ?? {}) as TDetails,
		isError: true,
	};
}

export function emitProgress<TDetails extends Record<string, unknown> = Record<string, unknown>>(
	onUpdate: TextToolUpdate<TDetails> | undefined,
	text: string,
	details?: TDetails,
): void {
	onUpdate?.(textResult(text, details));
}
