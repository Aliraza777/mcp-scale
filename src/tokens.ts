import type Anthropic from "@anthropic-ai/sdk";
import { getEncoding, type Tiktoken } from "js-tiktoken";

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

const EMPTY_SCHEMA = { type: "object", properties: {} };

/** The shape a tool definition takes when a client sends it to the model. */
export function serializeTool(tool: ToolDef): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description ?? "",
    input_schema: tool.inputSchema ?? EMPTY_SCHEMA,
  });
}

let encoder: Tiktoken | undefined;

/** Offline estimate with o200k_base. Claude's tokenizer typically counts ~15-20% more. */
export function estimateTokens(text: string): number {
  encoder ??= getEncoding("o200k_base");
  return encoder.encode(text).length;
}

export const estimateToolTokens = (tool: ToolDef) => estimateTokens(serializeTool(tool));

export const EXACT_MODEL = "claude-opus-5-5";

export type CountTokens = (tools: Anthropic.Tool[] | undefined) => Promise<number>;

export function anthropicCounter(client: Anthropic): CountTokens {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: "hi" }];
  return async (tools) =>
    (
      await client.messages.countTokens({
        model: EXACT_MODEL,
        messages,
        ...(tools ? { tools } : {}),
      })
    ).input_tokens;
}

const toApiTool = (t: ToolDef): Anthropic.Tool => ({
  name: t.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128),
  description: t.description ?? "",
  input_schema: (t.inputSchema ?? EMPTY_SCHEMA) as Anthropic.Tool.InputSchema,
});

/**
 * Exact Claude counts per server via the (free) count_tokens endpoint. Any request with tools
 * also carries a fixed tool-use system prompt; that overhead is measured once with a one-tool
 * probe and subtracted, so per-server numbers add up instead of each repeating it.
 */
export async function exactServerTokens(
  count: CountTokens,
  servers: ToolDef[][],
): Promise<{ perServer: number[]; overhead: number }> {
  const base = await count(undefined);
  const probeTool: ToolDef = { name: "x", description: "" };
  const overhead = Math.max(
    0,
    (await count([toApiTool(probeTool)])) - base - estimateToolTokens(probeTool),
  );
  const perServer: number[] = [];
  for (const tools of servers) {
    if (tools.length === 0) {
      perServer.push(0);
      continue;
    }
    perServer.push(Math.max(0, (await count(tools.map(toApiTool))) - base - overhead));
  }
  return { perServer, overhead };
}
