import { describe, expect, it } from "vitest";
import {
  defersTools,
  instructionTokens,
  loadModel,
  serverLoad,
  toolTokens,
} from "../src/clients-behavior.js";
import { estimateTokens } from "../src/tokens.js";
import { tempEnv, tool, write } from "./helpers.js";

const cc = (procEnv: NodeJS.ProcessEnv = {}, setup?: (env: ReturnType<typeof tempEnv>) => void) => {
  const env = tempEnv({ empty: true });
  setup?.(env);
  return loadModel("claude-code", env, procEnv);
};

describe("Claude Code Tool Search model", () => {
  it("defers by default and stays deferred behind a gateway", () => {
    expect(cc().mode.kind).toBe("deferred");
    expect(cc({ ANTHROPIC_BASE_URL: "https://gw.example.com" }).mode.kind).toBe("deferred");
    expect(cc({ ENABLE_TOOL_SEARCH: "true" }).mode.kind).toBe("deferred");
  });

  it("loads up front when Tool Search is off by env, betas, or permission deny", () => {
    expect(cc({ ENABLE_TOOL_SEARCH: "false" }).mode.kind).toBe("upfront");
    expect(cc({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }).mode.kind).toBe("upfront");
    expect(
      cc({}, (e) => write(e, "~/.claude/settings.json", { permissions: { deny: ["ToolSearch"] } }))
        .mode.kind,
    ).toBe("upfront");
  });

  it("parses auto and auto:N thresholds", () => {
    expect(cc({ ENABLE_TOOL_SEARCH: "auto" }).mode).toEqual({ kind: "auto", percent: 10 });
    expect(cc({ ENABLE_TOOL_SEARCH: "auto:5" }).mode).toEqual({ kind: "auto", percent: 5 });
  });

  it("reads env from settings files, local overriding user, and the shell overriding both", () => {
    const setup = (e: ReturnType<typeof tempEnv>) => {
      write(e, "~/.claude/settings.json", { env: { ENABLE_TOOL_SEARCH: "false" } });
      write(e, "./.claude/settings.local.json", { env: { ENABLE_TOOL_SEARCH: "auto:3" } });
    };
    expect(cc({}, setup).mode).toEqual({ kind: "auto", percent: 3 });
    expect(cc({ ENABLE_TOOL_SEARCH: "true" }, setup).mode.kind).toBe("deferred");
  });

  it("honors CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH for both limits", () => {
    expect(cc().descriptionLimit).toBe(4096);
    expect(cc().deferredDescriptionLimit).toBe(16384);
    expect(cc({ CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "8192" })).toMatchObject({
      descriptionLimit: 8192,
      deferredDescriptionLimit: 8192,
    });
  });

  it("treats every other client as loading everything up front", () => {
    const env = tempEnv({ empty: true });
    for (const c of ["cursor", "vscode", "windsurf", "codex", "gemini", "claude-desktop"] as const)
      expect(loadModel(c, env, {}).mode.kind).toBe("upfront");
  });
});

describe("server load", () => {
  const model = cc();
  const server = {
    name: "srv",
    client: "claude-code",
    scope: "user",
    sourceFile: "f",
    transport: "stdio",
  } as const;
  const tools = [
    tool("a", 0, { description: "x".repeat(10) }),
    tool("b", 0, { description: "y".repeat(10), alwaysLoad: true }),
  ];

  it("defers tools but keeps alwaysLoad tools and instructions", () => {
    const load = serverLoad(tools, server, "hello instructions", model);
    const fullA = toolTokens(tools[0]!, "srv", model);
    const fullB = toolTokens(tools[1]!, "srv", model);
    const inst = instructionTokens("hello instructions", model);
    expect(load.full).toBe(fullA + fullB + inst);
    expect(load.deferrableFull).toBe(fullA);
    expect(load.deferred).toBe(
      inst + fullB + Math.round((estimateTokens("mcp__srv__a") + 1) * model.tokenScale),
    );
    expect(load.instructions).toBe(inst);
  });

  it("server alwaysLoad true loads everything; false defers even tool-level alwaysLoad", () => {
    expect(
      serverLoad(tools, { ...server, alwaysLoad: true }, undefined, model).deferrableFull,
    ).toBe(0);
    const forced = serverLoad(tools, { ...server, alwaysLoad: false }, undefined, model);
    expect(forced.deferrableFull).toBe(forced.full);
  });

  it("counts truncated descriptions the way Claude Code sends them", () => {
    const long = tool("long", 0, { description: "word ".repeat(5_000) });
    const cut = toolTokens(long, "srv", model);
    const cursor = loadModel("cursor", tempEnv({ empty: true }), {});
    expect(cut).toBeLessThan(estimateTokens("word ".repeat(5_000)));
    expect(cut).toBeGreaterThan(estimateTokens("word ".repeat(800)));
    expect(toolTokens({ ...long, tokens: 12345 }, "srv", cursor)).toBe(12345);
  });

  it("auto mode defers only at or above the threshold", () => {
    const auto5 = cc({ ENABLE_TOOL_SEARCH: "auto:5" }); // 5% of 200k = 10k
    expect(defersTools(auto5, 9_999)).toBe(false);
    expect(defersTools(auto5, 10_000)).toBe(true);
    expect(defersTools(cc(), 0)).toBe(true);
    expect(defersTools(cc({ ENABLE_TOOL_SEARCH: "false" }), 1e9)).toBe(false);
  });
});

describe("tokenizer family", () => {
  const env = tempEnv({ empty: true });
  it("uses Claude scale for Claude clients and o200k for others, with overrides", () => {
    expect(loadModel("claude-code", env, {}).family).toBe("claude");
    expect(loadModel("claude-desktop", env, {}).tokenScale).toBeCloseTo(1.67);
    expect(loadModel("cursor", env, {}).tokenScale).toBe(1);
    expect(loadModel("cursor", env, {}, { family: "claude" }).tokenScale).toBeCloseTo(1.67);
    expect(loadModel("claude-code", env, {}, { family: "openai" }).tokenScale).toBe(1);
  });

  it("prefers exact counts for Claude clients only", () => {
    const t = tool("x", 100, { exactTokens: 999 });
    expect(toolTokens(t, "s", loadModel("claude-desktop", env, {}))).toBe(999);
    expect(toolTokens(t, "s", loadModel("cursor", env, {}))).toBe(100);
  });
});

describe("Claude Code version rules", () => {
  const env = tempEnv({ empty: true });
  const at = (v: string, procEnv: NodeJS.ProcessEnv = {}) =>
    loadModel("claude-code", env, procEnv, { claudeVersion: v });
  it("uses the 2,048-char description limit before 2.1.296 / 2.1.295", () => {
    expect(at("2.1.263")).toMatchObject({ descriptionLimit: 2048, deferredDescriptionLimit: 2048 });
    expect(at("2.1.295")).toMatchObject({
      descriptionLimit: 2048,
      deferredDescriptionLimit: 16384,
    });
    expect(at("2.1.296")).toMatchObject({
      descriptionLimit: 4096,
      deferredDescriptionLimit: 16384,
    });
  });
  it("ignores CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH before 2.1.280", () => {
    expect(at("2.1.279", { CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "9000" }).descriptionLimit).toBe(
      2048,
    );
    expect(at("2.1.280", { CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "9000" }).descriptionLimit).toBe(
      9000,
    );
  });
  it("turns Tool Search off behind a gateway before 2.1.304 unless ENABLE_TOOL_SEARCH=true", () => {
    const gw = { ANTHROPIC_BASE_URL: "https://gw" };
    expect(at("2.1.303", gw).mode.kind).toBe("upfront");
    expect(at("2.1.303", { ...gw, ENABLE_TOOL_SEARCH: "true" }).mode.kind).toBe("deferred");
    expect(at("2.1.304", gw).mode.kind).toBe("deferred");
  });
});
