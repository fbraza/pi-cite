export type PaperRecord = {
	pmid?: string;
	doi?: string;
	title: string;
	abstract?: string;
	authors?: string[];
	journal?: string;
	year?: number;
	publication_types?: string[];
	mesh_terms?: string[];
	source?: string;
	sources?: string[];
	date?: string;
	category?: string;
	version?: string;
	license?: string;
};
