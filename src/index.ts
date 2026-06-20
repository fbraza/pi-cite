import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLiteratureSearchTool } from "./literature-search.ts";
import { registerPubmedSearchTool } from "./pubmed.ts";

export default function literatureToolsExtension(pi: ExtensionAPI) {
  registerLiteratureSearchTool(pi);
  registerPubmedSearchTool(pi);
}
