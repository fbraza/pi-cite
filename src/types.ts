export type PaperRecord = {
	pmid?: string;
	doi?: string;
	s2_id?: string;
	title: string;
	abstract?: string;
	authors?: string[];
	journal?: string;
	year?: number;
	publication_types?: string[];
	mesh_terms?: string[];
	citation_count?: number;
	tldr?: string;
	open_access_pdf?: string;
	external_ids?: Record<string, string>;
	source?: string;
	sources?: string[];
	date?: string;
	category?: string;
	version?: string;
	license?: string;
	pdf_url?: string;
};

export type FullTextRouteResult = {
	source: string;
	pdf_url?: string;
	access_note: string;
	is_preprint?: boolean;
};
