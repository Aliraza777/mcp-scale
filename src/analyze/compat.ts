import type { LoadModel } from "../clients-behavior.js";
import type { ClientId, Finding, ToolInfo } from "../types.js";
import { normalizeServerName } from "./usage.js";

const PROPERTY_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const OPENAI_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Checks Claude Code documents for MCP tools it loads. */
export function claudeCodeCompat(
  server: string,
  tools: ToolInfo[],
  instructions: string | undefined,
  model: LoadModel,
  deferred: boolean,
): Finding[] {
  const out: Finding[] = [];
  const base = { server, client: "claude-code" as ClientId };
  const limit = (deferred ? model.deferredDescriptionLimit : model.descriptionLimit) ?? Infinity;

  const longNames = tools.filter(
    (t) => `mcp__${normalizeServerName(server)}__${t.name}`.length > 128,
  );
  if (longNames.length)
    out.push({
      ...base,
      id: "tool-name-too-long",
      severity: "warn",
      message: `${server}: ${longNames.length} tool(s) are dropped by Claude Code because mcp__${server}__<tool> exceeds 128 characters (${longNames.map((t) => t.name).join(", ")}). Rename the server to something shorter.`,
    });

  const badSchema = tools.filter((t) => {
    const props = (t.inputSchema as { properties?: unknown } | undefined)?.properties;
    return (
      props && typeof props === "object" && Object.keys(props).some((k) => !PROPERTY_NAME.test(k))
    );
  });
  if (badSchema.length)
    out.push({
      ...base,
      id: "invalid-property-names",
      severity: "warn",
      message: `${server}: ${badSchema.length} tool(s) have input property names the Claude API rejects (must match [A-Za-z0-9_.-]{1,64}); Claude Code excludes them: ${badSchema.map((t) => t.name).join(", ")}.`,
    });

  const combinator = tools.filter((t) => {
    const s = t.inputSchema as Record<string, unknown> | undefined;
    return s && ("anyOf" in s || "oneOf" in s || "allOf" in s);
  });
  if (combinator.length)
    out.push({
      ...base,
      id: "root-combinator",
      severity: "info",
      message: `${server}: ${combinator.length} tool(s) use anyOf/oneOf/allOf at the schema root; Claude Code flattens these and moves the constraints into the description (${combinator.map((t) => t.name).join(", ")}).`,
    });

  const truncated = tools.filter((t) => (t.description?.length ?? 0) > limit);
  if (truncated.length)
    out.push({
      ...base,
      id: "description-truncated",
      severity: "warn",
      message: `${server}: Claude Code cuts ${truncated.length} tool description(s) at ${limit.toLocaleString("en-US")} characters, so Claude never sees the rest (${truncated.map((t) => `${t.name} ${t.description?.length}`).join(", ")}).`,
    });
  if (instructions && model.descriptionLimit && instructions.length > model.descriptionLimit)
    out.push({
      ...base,
      id: "instructions-truncated",
      severity: "warn",
      message: `${server}: server instructions are ${instructions.length.toLocaleString("en-US")} characters; Claude Code keeps only the first ${model.descriptionLimit.toLocaleString("en-US")}.`,
    });
  return out;
}

/** OpenAI-style function names (used by Cursor, Copilot, Codex with GPT models) allow [A-Za-z0-9_-]{1,64}. */
export function openAiCompat(server: string, client: ClientId, tools: ToolInfo[]): Finding[] {
  const bad = tools.filter((t) => !OPENAI_TOOL_NAME.test(t.name));
  return bad.length
    ? [
        {
          id: "tool-name-incompatible",
          severity: "warn",
          server,
          client,
          message: `${server}: ${bad.length} tool name(s) break the OpenAI function-name rule ([A-Za-z0-9_-], max 64 chars) and may fail with GPT models: ${bad.map((t) => t.name).join(", ")}.`,
        },
      ]
    : [];
}
