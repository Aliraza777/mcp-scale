import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface ToolUsage {
  calls: number;
  lastUsed?: string;
  tools: Map<string, number>;
}

/** Claude Code names MCP tools `mcp__<server>__<tool>`, replacing unsupported characters with `_`. */
export const normalizeServerName = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_");

function* jsonlFiles(dir: string, depth = 0): Generator<string> {
  if (depth > 4) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p, depth + 1);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

/** Scan Claude Code transcripts (including subagents) for MCP tool calls in the last `days` days. */
export async function claudeCodeUsage(home: string, days = 30): Promise<Map<string, ToolUsage>> {
  const root = join(home, ".claude", "projects");
  const usage = new Map<string, ToolUsage>();
  if (!existsSync(root)) return usage;
  const since = Date.now() - days * 86_400_000;
  for (const file of jsonlFiles(root)) {
    try {
      if (statSync(file).mtimeMs < since) continue;
    } catch {
      continue;
    }
    const lines = createInterface({
      input: createReadStream(file),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      if (!line.includes('"mcp__') || !line.includes('"tool_use"')) continue;
      let entry: { timestamp?: string; message?: { content?: unknown } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = entry.timestamp;
      if (ts && Date.parse(ts) < since) continue;
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as Array<{ type?: string; name?: string }>) {
        if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
        const m = /^mcp__(.+?)__(.+)$/.exec(block.name);
        if (!m?.[1] || !m[2]) continue;
        const [, server, tool] = m;
        const u: ToolUsage = usage.get(server) ?? { calls: 0, tools: new Map() };
        u.calls++;
        u.tools.set(tool, (u.tools.get(tool) ?? 0) + 1);
        if (ts && (!u.lastUsed || ts > u.lastUsed)) u.lastUsed = ts;
        usage.set(server, u);
      }
    }
  }
  return usage;
}
