import { readClaudeSettings } from "./clients/claude-code.js";
import type { Env } from "./clients/env.js";
import { isRecord } from "./clients/util.js";
import { estimateTokens, serializeTool } from "./tokens.js";
import type { ClientId, ServerConfig, ToolInfo } from "./types.js";

/**
 * How a client loads MCP tool definitions at session start.
 * - upfront: every definition is sent with every request (all clients except Claude Code).
 * - deferred: Claude Code Tool Search — only tool names and server instructions load.
 * - auto: Claude Code ENABLE_TOOL_SEARCH=auto[:N] — upfront while the total is under N% of the window.
 */
export type LoadMode =
  | { kind: "upfront" }
  | { kind: "deferred" }
  | { kind: "auto"; percent: number };

export interface LoadModel {
  mode: LoadMode;
  /** Multiplier from the o200k estimate to this client's model tokenizer. */
  tokenScale: number;
  family: TokenFamily;
  note?: string;
  /** Claude Code cuts upfront descriptions and server instructions to this many characters. */
  descriptionLimit?: number;
  /** Description limit for tools loaded through Tool Search. */
  deferredDescriptionLimit?: number;
  /** Client prefixes tool names it sends to the model (Claude Code: mcp__server__tool). */
  prefixNames?: boolean;
  /** Server instructions are loaded into context. */
  countsInstructions?: boolean;
}

/**
 * Claude Code's own counts (`/context`, Claude Opus 5) are ≈1.67× the o200k estimate of the same
 * serialized definition: calibrated on 68 tools from 7 popular servers, mean error 5.4%, no
 * meaningful fixed per-tool overhead. GPT-family models use o200k itself.
 */
export const CLAUDE_TOKEN_SCALE = 1.67;

export type TokenFamily = "claude" | "openai";

export interface LoadOptions {
  /** "auto": Claude for Claude Code and Claude Desktop, OpenAI (o200k) for other clients. */
  family?: TokenFamily | "auto";
  /** Installed Claude Code version, when known; some rules changed between releases. */
  claudeVersion?: string;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Context window assumed for ENABLE_TOOL_SEARCH=auto thresholds. */
export const ASSUMED_CONTEXT_WINDOW = 200_000;

const truthy = (v: string | undefined) => v !== undefined && !/^(|0|false|off|no)$/i.test(v.trim());

export function loadModel(
  client: ClientId,
  env: Env,
  procEnv: NodeJS.ProcessEnv = process.env,
  opts: LoadOptions = {},
): LoadModel {
  const isClaude = client === "claude-code" || client === "claude-desktop";
  const family: TokenFamily =
    opts.family && opts.family !== "auto" ? opts.family : isClaude ? "claude" : "openai";
  const tokenScale = family === "claude" ? CLAUDE_TOKEN_SCALE : 1;
  if (client !== "claude-code") return { mode: { kind: "upfront" }, tokenScale, family };

  const version = opts.claudeVersion;
  const before = (v: string) => version !== undefined && compareVersions(version, v) < 0;
  const settings = readClaudeSettings(env).map((s) => s.data);
  // Later settings files (project, local) override earlier ones; the shell environment wins.
  const settingsEnv: Record<string, unknown> = Object.assign(
    {},
    ...settings.map((s) => (isRecord(s.env) ? s.env : {})),
  );
  const get = (k: string) => procEnv[k] ?? (settingsEnv[k] as string | undefined);
  const deniesToolSearch = settings.some(
    (s) =>
      isRecord(s.permissions) &&
      Array.isArray(s.permissions.deny) &&
      s.permissions.deny.includes("ToolSearch"),
  );
  const custom = before("2.1.280")
    ? Number.NaN
    : Number.parseInt(get("CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH") ?? "", 10);
  // Before 2.1.296 the upfront limit was 2,048; before 2.1.295 it applied to deferred tools too.
  const upfrontLimit = custom > 0 ? custom : before("2.1.296") ? 2_048 : 4_096;
  const deferredLimit = custom > 0 ? custom : before("2.1.295") ? 2_048 : 16_384;
  const base = {
    tokenScale,
    family,
    descriptionLimit: upfrontLimit,
    deferredDescriptionLimit: deferredLimit,
    prefixNames: true,
    countsInstructions: true,
  };
  const upfront = (note: string): LoadModel => ({ ...base, mode: { kind: "upfront" }, note });

  if (truthy(get("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS")))
    return upfront(
      "Tool Search off (CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS) — all tools load up front",
    );
  if (deniesToolSearch)
    return upfront("ToolSearch is denied in permissions — all tools load up front");

  const value = get("ENABLE_TOOL_SEARCH")?.trim().toLowerCase();
  if (value === "false" || value === "0" || value === "off")
    return upfront("ENABLE_TOOL_SEARCH=false — all tools load up front");
  const auto = value?.match(/^auto(?::(\d{1,3}))?$/);
  if (auto) {
    const percent = Math.min(100, Number(auto[1] ?? 10));
    return {
      ...base,
      mode: { kind: "auto", percent },
      note: `ENABLE_TOOL_SEARCH=${value} — tools load up front while under ${percent}% of the context window (assuming ${ASSUMED_CONTEXT_WINDOW.toLocaleString("en-US")})`,
    };
  }
  if (get("ANTHROPIC_BASE_URL") && value !== "true" && before("2.1.304"))
    return upfront(
      `Claude Code ${version} turns Tool Search off behind ANTHROPIC_BASE_URL — all tools load up front. Set ENABLE_TOOL_SEARCH=true or upgrade to 2.1.304+.`,
    );
  return {
    ...base,
    mode: { kind: "deferred" },
    note: "Tool Search on — only tool names and server instructions load until a tool is needed",
  };
}

const truncate = (s: string | undefined, n: number | undefined) =>
  s !== undefined && n !== undefined && s.length > n ? s.slice(0, n) : s;

/** Tokens of one tool's definition as this client sends it. */
export function toolTokens(tool: ToolInfo, server: string, model: LoadModel): number {
  if (model.family === "claude" && tool.exactTokens !== undefined) return tool.exactTokens;
  const raw =
    !model.prefixNames && model.descriptionLimit === undefined
      ? tool.tokens
      : estimateTokens(
          serializeTool({
            name: model.prefixNames ? `mcp__${server}__${tool.name}` : tool.name,
            description: truncate(tool.description, model.descriptionLimit),
            inputSchema: tool.inputSchema,
          }),
        );
  return Math.round(raw * model.tokenScale);
}

/** A deferred tool costs one line naming it. */
const deferredTokens = (tool: ToolInfo, server: string, model: LoadModel) =>
  Math.round((estimateTokens(`mcp__${server}__${tool.name}`) + 1) * model.tokenScale);

export function instructionTokens(instructions: string | undefined, model: LoadModel): number {
  if (!model.countsInstructions || !instructions) return 0;
  return Math.round(
    estimateTokens(truncate(instructions, model.descriptionLimit) ?? "") * model.tokenScale,
  );
}

/** Whether a tool would be deferred under Tool Search, honoring alwaysLoad overrides. */
export function isDeferrable(tool: ToolInfo, server: ServerConfig): boolean {
  if (server.alwaysLoad === true) return false;
  if (server.alwaysLoad === false) return true;
  return tool.alwaysLoad !== true;
}

export interface ServerLoad {
  /** Everything loaded up front. */
  full: number;
  /** Cost when deferrable tools are deferred. */
  deferred: number;
  /** Full cost of only the deferrable tools (for the auto threshold). */
  deferrableFull: number;
  /** Server instructions, included in both totals. */
  instructions: number;
}

export function serverLoad(
  tools: ToolInfo[],
  server: ServerConfig,
  instructions: string | undefined,
  model: LoadModel,
): ServerLoad {
  const inst = instructionTokens(instructions, model);
  let full = inst;
  let deferred = inst;
  let deferrableFull = 0;
  for (const t of tools) {
    const cost = toolTokens(t, server.name, model);
    full += cost;
    if (isDeferrable(t, server)) {
      deferrableFull += cost;
      deferred += deferredTokens(t, server.name, model);
    } else deferred += cost;
  }
  return { full, deferred, deferrableFull, instructions: inst };
}

/** Decide, for a whole client, whether deferrable tools are deferred. */
export function defersTools(model: LoadModel, totalDeferrableFull: number): boolean {
  if (model.mode.kind === "upfront") return false;
  if (model.mode.kind === "deferred") return true;
  return totalDeferrableFull >= (model.mode.percent / 100) * ASSUMED_CONTEXT_WINDOW;
}
