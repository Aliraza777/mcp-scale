import { utimesSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claudeCodeUsage, normalizeServerName } from "../src/analyze/usage.js";
import { applyExactCounts } from "../src/scan.js";
import { type CountTokens, estimateToolTokens, exactServerTokens } from "../src/tokens.js";
import { okProbe, tempEnv, tool, write } from "./helpers.js";

const now = new Date().toISOString();
const line = (content: unknown[], timestamp = now) =>
  JSON.stringify({ type: "assistant", timestamp, message: { role: "assistant", content } });
const use = (name: string) => ({ type: "tool_use", id: "x", name, input: {} });

describe("claudeCodeUsage", () => {
  it("counts real tool_use calls only, including subagent transcripts", async () => {
    const env = tempEnv({ empty: true });
    write(
      env,
      "~/.claude/projects/-p/s1.jsonl",
      [
        line([use("mcp__github__create_issue"), use("Bash"), use("mcp__github__list_prs")]),
        // tool search results mention tools without calling them
        JSON.stringify({
          timestamp: now,
          toolUseResult: { surfacedDefinitions: [{ name: "mcp__github__x" }] },
          message: { content: [{ type: "tool_result", tool_use_id: "x" }] },
          note: '"tool_use"',
        }),
        line([use("mcp__claude_ai_Docs__read")]),
        line([use("mcp__github__old")], "2020-01-01T00:00:00Z"),
        "not json {",
      ].join("\n"),
    );
    write(
      env,
      "~/.claude/projects/-p/s1/subagents/a.jsonl",
      line([use("mcp__plugin_x_db__query")]),
    );
    const u = await claudeCodeUsage(env.home, 30);
    expect(u.get("github")?.calls).toBe(2);
    expect([...(u.get("github")?.tools.keys() ?? [])]).toEqual(["create_issue", "list_prs"]);
    expect(u.get("claude_ai_Docs")?.calls).toBe(1);
    expect(u.get("plugin_x_db")?.calls).toBe(1);
  });

  it("skips transcripts not modified within the window", async () => {
    const env = tempEnv({ empty: true });
    const f = write(env, "~/.claude/projects/-p/old.jsonl", line([use("mcp__a__b")]));
    const old = new Date("2020-01-01");
    utimesSync(f, old, old);
    expect((await claudeCodeUsage(env.home, 30)).size).toBe(0);
  });

  it("normalizes server names like Claude Code", () => {
    expect(normalizeServerName("claude.ai Slack")).toBe("claude_ai_Slack");
    expect(normalizeServerName("my-server_1")).toBe("my-server_1");
  });
});

describe("exact counting", () => {
  // Fake count_tokens: 10 base + 300 tool-use overhead when tools are present + 7 per tool.
  const counter: CountTokens = async (tools) => 10 + (tools?.length ? 300 + 7 * tools.length : 0);

  it("subtracts the one-time tool-use overhead from each server", async () => {
    const one = { name: "x", description: "" };
    const { perServer, overhead } = await exactServerTokens(counter, [[one, one], [], [one]]);
    expect(overhead).toBe(307 - estimateToolTokens(one));
    expect(perServer[1]).toBe(0);
    expect(perServer[0]! - perServer[2]!).toBe(7);
  });

  it("scales per-tool estimates to the exact server total", async () => {
    const probe = okProbe([tool("a", 30), tool("b", 10)]);
    await applyExactCounts(new Map([["k", probe]]), async (tools) =>
      tools?.length ? 1000 + tools.length * 50 : 0,
    );
    const total = probe.tools.reduce((n, t) => n + t.tokens, 0);
    expect(total).toBeGreaterThan(0);
    expect(probe.tools[0]!.tokens).toBeGreaterThan(probe.tools[1]!.tokens);
  });
});
