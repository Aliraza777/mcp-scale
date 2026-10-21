import { describe, expect, it } from "vitest";
import { discover } from "../src/clients/index.js";
import { stripJsonComments } from "../src/clients/util.js";
import { fixtureEnv, tempEnv, write } from "./helpers.js";

describe("discover (fixtures)", () => {
  const { servers, errors } = discover(fixtureEnv());
  const find = (client: string, name: string) =>
    servers.find((s) => s.client === client && s.name === name);

  it("reads every client without errors", () => {
    expect(errors).toEqual([]);
    expect(new Set(servers.map((s) => s.client))).toEqual(
      new Set(["claude-code", "claude-desktop", "cursor", "vscode", "windsurf", "codex"]),
    );
  });

  it("parses Claude Code user and project scopes", () => {
    expect(find("claude-code", "github")).toMatchObject({ scope: "user", transport: "stdio" });
    expect(find("claude-code", "linear")).toMatchObject({
      transport: "http",
      url: "https://mcp.linear.app/mcp",
    });
    expect(find("claude-code", "sentry")).toMatchObject({ scope: "project", transport: "sse" });
  });

  it("applies Claude Code local scope for the matching project path", () => {
    const local = discover(fixtureEnv({ cwd: "/work/app" })).servers;
    expect(local.find((s) => s.name === "postgres")).toMatchObject({ scope: "local" });
  });

  it("parses VS Code JSONC with the servers key", () => {
    expect(find("vscode", "fs")).toMatchObject({
      scope: "user",
      args: expect.arrayContaining(["/"]),
    });
    expect(find("vscode", "docs")).toMatchObject({ scope: "project", transport: "http" });
  });

  it("treats a bare url without type as HTTP with SSE fallback", () => {
    expect(find("cursor", "remote")).toMatchObject({ transport: "http", transportExplicit: false });
    expect(find("vscode", "docs")?.transportExplicit).toBe(true);
  });

  it("parses Codex TOML, Windsurf, and Claude Desktop disabled flags", () => {
    expect(find("codex", "context7")).toMatchObject({ env: { DEBUG: "1" } });
    expect(find("windsurf", "brave")?.env?.BRAVE_API_KEY).toBeDefined();
    expect(find("claude-desktop", "memory")).toMatchObject({ disabled: true });
  });

  it("filters by client", () => {
    const only = discover(fixtureEnv(), ["cursor"]).servers;
    expect(only.every((s) => s.client === "cursor")).toBe(true);
    expect(only).toHaveLength(2);
  });
});

describe("Claude Code rules", () => {
  it("disables .mcp.json servers listed in any settings file", () => {
    const env = tempEnv({ empty: true });
    write(env, "./.mcp.json", { mcpServers: { a: { command: "x" }, b: { command: "y" } } });
    write(env, "./.claude/settings.local.json", { disabledMcpjsonServers: ["a"] });
    const s = discover(env, ["claude-code"]).servers;
    expect(s.find((x) => x.name === "a")).toMatchObject({ disabled: true });
    expect(s.find((x) => x.name === "b")?.disabled).toBeFalsy();
  });

  it("gives managed-mcp.json exclusive control", () => {
    const env = tempEnv({ empty: true });
    write(env, "~/.claude.json", { mcpServers: { mine: { command: "x" } } });
    write(env, env.managedMcpFile, {
      mcpServers: { corp: { type: "http", url: "https://corp/mcp" } },
    });
    const s = discover(env, ["claude-code"]).servers;
    expect(s.find((x) => x.name === "corp")).toMatchObject({ scope: "managed", disabled: false });
    expect(s.find((x) => x.name === "mine")).toMatchObject({
      disabled: true,
      disabledReason: expect.stringContaining("managed-mcp.json"),
    });
  });

  it("applies deniedMcpServers by name, command and URL pattern", () => {
    const env = tempEnv({ empty: true });
    write(env, "~/.claude.json", {
      mcpServers: {
        byName: { command: "a" },
        byCmd: { command: "npx", args: ["-y", "bad"] },
        byUrl: { type: "http", url: "https://evil.example.com/mcp" },
        ok: { type: "http", url: "https://good.example.com/mcp" },
      },
    });
    write(env, "~/.claude/settings.json", {
      deniedMcpServers: [
        { serverName: "byName" },
        { serverCommand: ["npx", "-y", "bad"] },
        { serverUrl: "https://*.example.com/*" },
      ],
    });
    write(env, "./.claude/settings.json", {
      deniedMcpServers: [{ serverUrl: "https://nomatch.dev" }],
    });
    const s = discover(env, ["claude-code"]).servers;
    const off = (n: string) => s.find((x) => x.name === n)?.disabled;
    expect([off("byName"), off("byCmd"), off("byUrl")]).toEqual([true, true, true]);
    // the wildcard matches good.example.com too
    expect(off("ok")).toBe(true);
  });

  it("reads alwaysLoad and the streamable-http alias, flags websocket as unsupported", () => {
    const env = tempEnv({ empty: true });
    write(env, "~/.claude.json", {
      mcpServers: {
        a: { type: "streamable-http", url: "https://a/mcp", alwaysLoad: true },
        w: { type: "ws", url: "wss://w" },
      },
    });
    const s = discover(env, ["claude-code"]).servers;
    expect(s.find((x) => x.name === "a")).toMatchObject({ transport: "http", alwaysLoad: true });
    expect(s.find((x) => x.name === "w")?.unsupported).toMatch(/not supported/);
  });
});

describe("Claude Code .mcp.json approval", () => {
  const setup = (extra: (env: ReturnType<typeof tempEnv>) => void = () => {}) => {
    const env = tempEnv({ empty: true });
    write(env, "./.mcp.json", { mcpServers: { a: { command: "x" }, b: { command: "y" } } });
    extra(env);
    const s = discover(env, ["claude-code"]).servers;
    return (n: string) => s.find((x) => x.name === n)?.pendingApproval ?? false;
  };

  it("is pending until approved", () => {
    expect(setup()("a")).toBe(true);
  });

  it("is approved by ~/.claude.json enabledMcpjsonServers for this project", () => {
    const pending = setup((env) =>
      write(env, "~/.claude.json", { projects: { [env.cwd]: { enabledMcpjsonServers: ["a"] } } }),
    );
    expect([pending("a"), pending("b")]).toEqual([false, true]);
  });

  it("ignores project settings approvals in an untrusted folder", () => {
    expect(
      setup((env) =>
        write(env, "./.claude/settings.local.json", { enableAllProjectMcpServers: true }),
      )("a"),
    ).toBe(true);
  });

  it("honors project settings approvals once the folder (or a parent) is trusted", () => {
    const pending = setup((env) => {
      write(env, "./.claude/settings.local.json", { enableAllProjectMcpServers: true });
      write(env, "~/.claude.json", {
        projects: { [env.cwd.replace(/\/project$/, "")]: { hasTrustDialogAccepted: true } },
      });
    });
    expect(pending("a")).toBe(false);
  });

  it("always honors approvals in user settings", () => {
    expect(
      setup((env) => write(env, "~/.claude/settings.json", { enabledMcpjsonServers: ["b"] }))("b"),
    ).toBe(false);
  });
});

describe("other clients", () => {
  it("Gemini: url is SSE, httpUrl is HTTP, include/excludeTools become a filter", () => {
    const env = tempEnv({ empty: true });
    write(env, "~/.gemini/settings.json", {
      mcpServers: {
        legacy: { url: "https://s/sse" },
        modern: { httpUrl: "https://h/mcp", excludeTools: ["drop"] },
        local: { command: "node", args: ["s.js"], includeTools: ["keep"] },
      },
    });
    const s = discover(env, ["gemini"]).servers;
    expect(s.find((x) => x.name === "legacy")).toMatchObject({ transport: "sse" });
    expect(s.find((x) => x.name === "modern")).toMatchObject({
      transport: "http",
      toolFilter: { exclude: ["drop"] },
    });
    expect(s.find((x) => x.name === "local")?.toolFilter).toEqual({
      include: ["keep"],
      exclude: undefined,
    });
  });

  it("Codex: bearer_token_env_var, env_http_headers, enabled=false and tool filters", () => {
    const env = tempEnv({ empty: true });
    write(
      env,
      "~/.codex/config.toml",
      `[mcp_servers.remote]
url = "https://r/mcp"
bearer_token_env_var = "R_TOKEN"
env_http_headers = { "X-Team" = "TEAM_ID" }
disabled_tools = ["slow"]

[mcp_servers.off]
command = "x"
enabled = false
`,
    );
    const s = discover(env, ["codex"]).servers;
    expect(s.find((x) => x.name === "remote")).toMatchObject({
      transport: "http",
      headers: { Authorization: "Bearer ${R_TOKEN}", "X-Team": "${TEAM_ID}" },
      toolFilter: { exclude: ["slow"] },
    });
    expect(s.find((x) => x.name === "off")?.disabled).toBe(true);
  });

  it("Claude Desktop extensions: substitutes __dirname and user_config, honors isEnabled", () => {
    const env = tempEnv({ empty: true });
    const base = `${env.appData}/Claude`;
    write(env, `${base}/Claude Extensions/ext.fs/manifest.json`, {
      name: "fs-ext",
      display_name: "Filesystem",
      server: {
        type: "node",
        mcp_config: {
          command: "node",
          args: ["${__dirname}/server/index.js", "${user_config.root}"],
          env: { TOKEN: "${user_config.token}" },
        },
      },
      user_config: { root: { type: "directory", default: "/tmp" }, token: { type: "string" } },
    });
    write(env, `${base}/Claude Extensions Settings/ext.fs.json`, {
      isEnabled: false,
      userConfig: { token: "abc" },
    });
    const [ext] = discover(env, ["claude-desktop"]).servers;
    expect(ext).toMatchObject({
      name: "Filesystem",
      scope: "extension",
      command: "node",
      args: [`${base}/Claude Extensions/ext.fs/server/index.js`, "/tmp"],
      env: { TOKEN: "abc" },
      disabled: true,
    });
  });

  it("reports a malformed config without hiding the other clients", () => {
    const env = tempEnv({ empty: true });
    write(env, "~/.cursor/mcp.json", "{ not json");
    write(env, "~/.codeium/windsurf/mcp_config.json", { mcpServers: { w: { command: "x" } } });
    const { servers, errors } = discover(env);
    expect(errors).toEqual([{ client: "cursor", error: expect.stringContaining("Invalid JSON") }]);
    expect(servers.map((s) => s.name)).toEqual(["w"]);
  });

  it("accepts a UTF-8 BOM", () => {
    const env = tempEnv({ empty: true });
    write(env, "~/.cursor/mcp.json", `﻿${JSON.stringify({ mcpServers: { b: { command: "x" } } })}`);
    expect(discover(env, ["cursor"]).servers.map((s) => s.name)).toEqual(["b"]);
  });
});

describe("stripJsonComments", () => {
  it("keeps // inside strings and removes trailing commas", () => {
    expect(JSON.parse(stripJsonComments('{"u": "https://x.dev/a", // c\n "b": [1,],}'))).toEqual({
      u: "https://x.dev/a",
      b: [1],
    });
  });
});
