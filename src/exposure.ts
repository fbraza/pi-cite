import type { ExtensionAPI, ExtensionContext, ToolDefinition, ToolExposure } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { LITERATURE_TOOL_NAMES, type LiteratureToolName } from "./tool-metadata.ts";

const STATE_ENTRY = "pi-cite-exposure";
const preferenceSchema = Type.Enum(["auto", "enabled", "disabled"]);
const configuredSchema = Type.Partial(Type.Record(Type.Enum(LITERATURE_TOOL_NAMES), Type.Enum(["enabled", "disabled"])));
const stateSchema = Type.Object({
  version: Type.Literal(1),
  preferences: Type.Record(Type.Enum(LITERATURE_TOOL_NAMES), preferenceSchema),
  configured: configuredSchema,
  active: Type.Array(Type.Enum(LITERATURE_TOOL_NAMES)),
}, { additionalProperties: false });
type ExposureState = Static<typeof stateSchema>;

export type ManagedLiteratureTool = {
  name: LiteratureToolName;
  register: (exposure: ToolExposure) => void;
};

/** Registration is valid before binding; no session APIs are read here. */
export function manageLiteratureTool<TParams extends TSchema, TDetails>(
  pi: ExtensionAPI,
  tool: ToolDefinition<TParams, TDetails>,
): ManagedLiteratureTool {
  if (!isLiteratureTool(tool.name)) throw new Error(`Unknown literature tool: ${tool.name}`);
  const name = tool.name;
  const register = (exposure: ToolExposure) => pi.registerTool({ ...tool, exposure, defaultActive: false });
  register("direct");
  return { name, register };
}

function isLiteratureTool(name: string): name is LiteratureToolName {
  return LITERATURE_TOOL_NAMES.some(tool => tool === name);
}

function readState(ctx: ExtensionContext): ExposureState | undefined {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type === "custom" && entry.customType === STATE_ENTRY && Value.Check(stateSchema, entry.data)) {
      // Copy, so observing changes never mutates persisted branch entries.
      return structuredClone(entry.data);
    }
  }
  return undefined;
}

function configuredPreferences(pi: ExtensionAPI): ExposureState["configured"] {
  const entries = pi.getSettings().defaultTools;
  const result: ExposureState["configured"] = {};
  if (!Array.isArray(entries)) return result;
  // Pi first collects plain names, then applies +/- modifiers in their list order.
  for (const name of entries) {
    if (typeof name === "string" && isLiteratureTool(name)) result[name] = "enabled";
  }
  for (const entry of entries) {
    if (typeof entry !== "string" || !/^[+-]/.test(entry)) continue;
    const name = entry.slice(1);
    if (isLiteratureTool(name)) result[name] = entry.startsWith("+") ? "enabled" : "disabled";
  }
  return result;
}

function freshState(): ExposureState {
  return {
    version: 1,
    preferences: {
      literature_search: "auto", pubmed_search: "auto", zotero_search: "auto", europe_pmc_fulltext: "auto",
    },
    configured: {},
    active: [],
  };
}

/** Own only the literature tools. Reconcile at idle/start boundaries, never in loadout hooks. */
export function registerAutomaticExposure(pi: ExtensionAPI, tools: ManagedLiteratureTool[]): void {
  let state: ExposureState | undefined;
  let persisted: string | undefined;

  const observe = (ctx: ExtensionContext, reset = false, preserveRestored = false): string[] => {
    const active = pi.getActiveTools();
    const initialSelections: LiteratureToolName[] = [];
    if (reset || !state) {
      state = readState(ctx);
      persisted = state ? JSON.stringify(state) : undefined;
      const restored = state !== undefined;
      const previous = new Set(state?.active ?? []);
      state ??= freshState();
      // Tools start default-inactive. New active names were explicitly selected by
      // Pi/settings/the caller; restored automatic active names retain their policy.
      for (const name of active.filter(isLiteratureTool)) {
        if (!previous.has(name) && !(preserveRestored && restored)) initialSelections.push(name);
      }
    } else {
      const previous = new Set(state.active);
      const current = new Set(active);
      for (const name of LITERATURE_TOOL_NAMES) {
        if (current.has(name) !== previous.has(name)) {
          state.preferences[name] = current.has(name) ? "enabled" : "disabled";
        }
      }
    }
    const configured = configuredPreferences(pi);
    for (const name of initialSelections) {
      // A repeated +name setting can activate a tool again when a new SDK session
      // reconstructs defaults. Preserve a recorded manual disable in that case.
      if (state.preferences[name] === "disabled" && configured[name] === "enabled" && state.configured[name] === "enabled") continue;
      state.preferences[name] = "enabled";
    }
    for (const name of LITERATURE_TOOL_NAMES) {
      if (configured[name] !== undefined && configured[name] !== state.configured[name]) {
        state.preferences[name] = configured[name];
      }
    }
    // Explicit initial activation overrides a conflicting -name default, just
    // as Pi's CLI/SDK tool allowlist overrides defaultTools.
    for (const name of initialSelections) {
      if (configured[name] !== "enabled") state.preferences[name] = "enabled";
    }
    state.configured = configured;
    return active;
  };

  const persist = (active: string[]): void => {
    if (!state) return;
    state.active = active.filter(isLiteratureTool);
    const serialized = JSON.stringify(state);
    if (serialized !== persisted) {
      pi.appendEntry(STATE_ENTRY, structuredClone(state));
      persisted = serialized;
    }
  };

  const reconcile = (ctx: ExtensionContext, reset = false, preserveRestored = false): void => {
    const active = observe(ctx, reset, preserveRestored);
    if (!state) return;
    const codemodeActive = active.includes("codemode");
    const configuredTools = new Map(pi.getAllTools().map(tool => [tool.name, tool]));
    const selected = new Set<LiteratureToolName>();
    for (const tool of tools) {
      // CLI/SDK allowlists and exclusions filter Pi's registry. Never bring an
      // excluded tool back by registering it again or bypassing that registry.
      const current = configuredTools.get(tool.name);
      if (!current) continue;
      const preference = state.preferences[tool.name];
      const exposure: ToolExposure = codemodeActive && preference === "auto" ? "codemode" : "direct";
      if (preference === "enabled" || (preference === "auto" && !codemodeActive)) selected.add(tool.name);
      // Disabled tools stay inactive/direct, so scripts cannot call them, but
      // an explicit later activation can still re-enable them through Pi.
      if (current.exposure !== exposure) tool.register(exposure);
    }
    const next = active.filter(name => !isLiteratureTool(name) || selected.has(name));
    for (const tool of tools) {
      if (selected.has(tool.name) && !next.includes(tool.name)) next.push(tool.name);
    }
    // Re-registration can refresh Pi's loadout. Restore exactly the intended
    // selection afterwards, preserving all unrelated active names and ordering.
    const actual = pi.getActiveTools();
    if (next.length !== actual.length || next.some((name, index) => name !== actual[index])) pi.setActiveTools(next);
    persist(pi.getActiveTools());
  };

  pi.on("session_start", (event, ctx) => reconcile(ctx, true, event.reason === "reload"));
  pi.on("session_tree", (_event, ctx) => reconcile(ctx, true, true));
  pi.on("before_agent_start", (_event, ctx) => reconcile(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    // Capture last-minute manual selections before reload/disposal, without
    // re-registering tools or changing the loadout during shutdown.
    persist(observe(ctx));
  });
}
