export type TextToolBlock = {
	type: "text";
	text: string;
};

export type TextToolPayload<TDetails extends Record<string, unknown> = Record<string, unknown>> = {
	content: TextToolBlock[];
	details: TDetails;
	isError?: boolean;
};

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
