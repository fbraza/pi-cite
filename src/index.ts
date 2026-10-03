import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEuropePmcFulltextTool } from "./europe-pmc.ts";
import { createLiteratureSearchTool } from "./literature-search.ts";
import { createPubmedSearchTool } from "./pubmed.ts";
import { createZoteroSearchTool } from "./zotero.ts";
import { manageLiteratureTool, registerAutomaticExposure } from "./exposure.ts";

export default function literatureToolsExtension(pi: ExtensionAPI) {
  const tools = [
    manageLiteratureTool(pi, createLiteratureSearchTool()),
    manageLiteratureTool(pi, createPubmedSearchTool()),
    manageLiteratureTool(pi, createZoteroSearchTool()),
    manageLiteratureTool(pi, createEuropePmcFulltextTool()),
  ];
  registerAutomaticExposure(pi, tools);
}
