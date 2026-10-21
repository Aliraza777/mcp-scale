import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyError, configKey, expandVars, probe, probeAll } from "../src/probe.js";
import { estimateToolTokens } from "../src/tokens.js";
import type { ServerConfig } from "../src/types.js";
import { FAKE_INSTRUCTIONS, startHttpServers } from "./fixtures/mcp-server.js";
import { FAKE_SERVER, stdioFake, TSX } from "./helpers.js";

describe("stdio probe", () => {
  it("lists all tools across pages, with instructions, metadata and token counts", async () => {
    const r = await probe(stdioFake());
    expect(r).toMatchObject({
      status: "ok",
      serverVersion: "9.9.9",
      instructions: FAKE_INSTRUCTIONS,
      transportUsed: "stdio",
    });
    expect(r.tools.map((t) => t.name)).toEqual(["tool_0", "tool_1", "tool_2"]);
    expect(r.tools.map((t) => t.alwaysLoad)).toEqual([undefined, true, undefined]);
    for (const t of r.tools) expect(t.tokens).toBe(estimateToolTokens(t));
  }, 30_000);

  it("declares roots and elicitation like real clients", async () => {
    const r = await probe(stdioFake({ args: ["--import", TSX, FAKE_SERVER, "--needs-roots"] }), {
      ctx: { env: {}, cwd: "/tmp/ws" },
    });
    expect(r.tools.map((t) => t.name)).toContain("roots_tool");
  }, 30_000);

  it("tolerates a banner line on stdout", async () => {
    const r = await probe(stdioFake({ args: ["--import", TSX, FAKE_SERVER, "--banner"] }));
    expect(r.status).toBe("ok");
    expect(r.tools).toHaveLength(3);
  }, 30_000);

  it("explains a crash with the server's stderr", async () => {
    const r = await probe(stdioFake({ args: ["--import", TSX, FAKE_SERVER, "--crash"] }));
    expect(r.status).toBe("error");
    expect(r.error).toContain("FAKE_API_KEY is required");
  }, 30_000);

  it("times out a server that never answers and leaves no process behind", async () => {
    const args = ["--import", TSX, FAKE_SERVER, "--hang", `--marker-${process.pid}`];
    const r = await probe(stdioFake({ args }), { timeoutMs: 2_000 });
    expect(r.status).toBe("timeout");
    await new Promise((res) => setTimeout(res, 500));
    const ps = execSync("ps ax -o command").toString();
    expect(ps).not.toContain(`--marker-${process.pid}`);
  }, 30_000);

  it("reports a missing command", async () => {
    const r = await probe(stdioFake({ command: "definitely-not-a-command-xyz", args: [] }), {
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("error");
  }, 10_000);

  it("starts identical servers from different clients once", async () => {
    const started: string[] = [];
    const a = stdioFake();
    const results = await probeAll(
      [a, { ...a, client: "vscode" }, { ...a, client: "codex", disabled: true }],
      {
        onDone: (s) => started.push(s.client),
      },
    );
    expect(results.size).toBe(1);
    expect(started).toEqual(["cursor"]);
    expect(results.get(configKey(a))?.ok).toBe(true);
  }, 30_000);

  it("refuses unsupported transports without connecting", async () => {
    const r = await probe({
      ...stdioFake(),
      transport: "http",
      url: "wss://x",
      unsupported: "ws transport is not supported",
    });
    expect(r).toMatchObject({
      status: "error",
      error: "ws transport is not supported",
      latencyMs: 0,
    });
  });
});

describe("HTTP probe", () => {
  let base = "";
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ base, close } = await startHttpServers());
  });
  afterAll(() => close());
  const http = (url: string, extra: Partial<ServerConfig> = {}): ServerConfig => ({
    name: "h",
    client: "cursor",
    scope: "user",
    sourceFile: "x",
    transport: "http",
    transportExplicit: true,
    url,
    ...extra,
  });

  it("speaks Streamable HTTP", async () => {
    const r = await probe(http(`${base}/mcp`));
    expect(r).toMatchObject({ status: "ok", transportUsed: "http" });
    expect(r.tools).toHaveLength(3);
  });

  it("falls back to SSE when no transport was declared", async () => {
    const r = await probe(http(`${base}/sse`, { transportExplicit: false }));
    expect(r).toMatchObject({ status: "ok", transportUsed: "sse" });
    expect(r.tools).toHaveLength(3);
  });

  it("does not fall back when HTTP was declared explicitly", async () => {
    const r = await probe(http(`${base}/sse`));
    expect(r.status).toBe("error");
  });

  it("speaks legacy SSE when declared", async () => {
    const r = await probe(http(`${base}/sse`, { transport: "sse" }));
    expect(r).toMatchObject({ status: "ok", transportUsed: "sse" });
  });

  it("classifies 401 as needing sign-in", async () => {
    const r = await probe(http(`${base}/auth`, { transportExplicit: false }));
    expect(r.status).toBe("auth");
  });

  it("expands ${VAR} in headers from the environment", async () => {
    const s = http(`${base}/bearer`, {
      headers: { Authorization: "Bearer ${MCP_SCALE_TEST_TOKEN}" },
    });
    expect((await probe(s, { ctx: { env: {} } })).status).toBe("auth");
    expect((await probe(s, { ctx: { env: { MCP_SCALE_TEST_TOKEN: "secret" } } })).status).toBe(
      "ok",
    );
  });

  it("reports a connection refused as an error", async () => {
    const r = await probe(http("http://127.0.0.1:1/mcp"), { timeoutMs: 5_000 });
    expect(r.status).toBe("error");
  });
});

describe("expandVars", () => {
  const ctx = { env: { T: "abc", EMPTY: "" }, home: "/h", cwd: "/w/proj" };
  it("expands env forms, defaults and editor variables", () => {
    expect(expandVars("Bearer ${T}", ctx)).toBe("Bearer abc");
    expect(expandVars("${env:T}", ctx)).toBe("abc");
    expect(expandVars("${MISSING:-fallback}", ctx)).toBe("fallback");
    expect(expandVars("${EMPTY:-fallback}", ctx)).toBe("fallback");
    expect(expandVars("${userHome}/x ${workspaceFolder} ${workspaceFolderBasename}", ctx)).toBe(
      "/h/x /w/proj proj",
    );
    expect(expandVars("${input:apiKey}", ctx)).toBe("");
    expect(expandVars("no vars", ctx)).toBe("no vars");
  });
});

describe("classifyError", () => {
  it("separates auth, timeout-like and generic errors", () => {
    expect(classifyError(Object.assign(new Error(""), { code: 401 }))).toEqual({
      status: "auth",
      message: "HTTP 401",
    });
    expect(
      classifyError(new Error("bad request: missing required Authorization header")).status,
    ).toBe("auth");
    expect(classifyError(new Error("ECONNREFUSED")).status).toBe("error");
  });
});
