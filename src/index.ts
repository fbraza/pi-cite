import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFetchFulltextTool } from "./fulltext.ts";
import { registerLiteratureSearchTool } from "./literature-search.ts";
import { registerPubmedSearchTool } from "./pubmed.ts";
import { registerSemanticScholarSearchTool } from "./semantic-scholar.ts";

export default function literatureToolsExtension(pi: ExtensionAPI) {
  registerLiteratureSearchTool(pi);
  registerPubmedSearchTool(pi);
  registerSemanticScholarSearchTool(pi);
  registerFetchFulltextTool(pi);
}
