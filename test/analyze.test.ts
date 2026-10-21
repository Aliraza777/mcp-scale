import { describe, expect, it } from "vitest";
import { hygiene, isPinned, runnerPackage } from "../src/analyze/hygiene.js";
import { analyze, applyToolFilter, totalSavings } from "../src/analyze/index.js";
import { findSecrets } from "../src/analyze/secrets.js";
import { discover } from "../src/clients/index.js";
import { configKey } from "../src/probe.js";
import { renderJson } from "../src/report/json.js";
import { renderMarkdown } from "../src/report/markdown.js";
import { renderTerminal } from "../src/report/terminal.js";
import type { ServerConfig } from "../src/types.js";
import { failedProbe, fixtureEnv, okProbe, tempEnv, tool } from "./helpers.js";

const base: Omit<ServerConfig, "name"> = {
  client: "cursor",
  scope: "user",
  sourceFile: "f",
  transport: "stdio",
  command: "node",
};
const ids = (r: { findings: { id: string }[] }) => r.findings.map((f) => f.id);
const run = (
  servers: ServerConfig[],
  probes: Array<[ServerConfig, ReturnType<typeof okProbe>]>,
  extra = {},
) =>
  analyze({
    env: tempEnv({ empty: true }),
    servers,
    probes: new Map(probes.map(([s, p]) => [configKey(s), p])),
    tokenizer: "t",
    checkPath: false,
    procEnv: {},
    ...extra,
  });

describe("secrets", () => {
  it("flags known token formats and masks them", () => {
    const [f] = findSecrets({
      ...base,
      name: "gh",
      env: { GITHUB_TOKEN: "ghp_FAKEfakeFAKEfakeFAKEfake000000" },
    });
    expect(f?.id).toBe("hardcoded-secret");
    expect(f?.message).not.toContain("FAKEfakeFAKEfake");
  });
  it("flags long values under secret-like keys and URL query params, ignores references", () => {
    expect(
      findSecrets({ ...base, name: "b", env: { BRAVE_API_KEY: "BSAabcdefghijklmnopqrstu" } }),
    ).toHaveLength(1);
    expect(
      findSecrets({
        ...base,
        name: "u",
        transport: "http",
        url: "https://x.dev/mcp?api_key=abcdef1234567890xyz",
      }),
    ).toHaveLength(1);
    expect(
      findSecrets({
        ...base,
        name: "r",
        env: { API_KEY: "${API_KEY}" },
        headers: { Authorization: "Bearer ${T}" },
      }),
    ).toEqual([]);
    expect(
      findSecrets({
        ...base,
        name: "q",
        transport: "http",
        url: "https://x.dev/mcp?api_key=${KEY}",
      }),
    ).toEqual([]);
    expect(
      findSecrets({ ...base, name: "d", env: { DEBUG: "1", LOG_LEVEL: "verbose-output-mode" } }),
    ).toEqual([]);
  });
});

describe("hygiene", () => {
  it("finds the package for npx, uvx --from, pnpm dlx", () => {
    expect(runnerPackage("npx", ["-y", "@playwright/mcp@latest"])).toBe("@playwright/mcp@latest");
    expect(runnerPackage("uvx", ["--from", "mcp-server-git==1.2", "mcp-server-git"])).toBe(
      "mcp-server-git==1.2",
    );
    expect(runnerPackage("pnpm", ["dlx", "foo@1"])).toBe("foo@1");
    expect(runnerPackage("C:\\nodejs\\npx.cmd", ["bar"])).toBe("bar");
    expect(runnerPackage("node", ["server.js"])).toBeUndefined();
  });
  it("knows what pinned means", () => {
    expect(["pkg@1.2.3", "@s/p@1", "py==1.0"].map(isPinned)).toEqual([true, true, true]);
    expect(["pkg", "@s/p", "pkg@latest", "pkg@next"].map(isPinned)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
  it("flags commands missing from PATH, but not disabled servers", () => {
    expect(hygiene({ ...base, name: "x", command: "nope-not-here-xyz" }).map((f) => f.id)).toEqual([
      "command-not-found",
    ]);
    expect(hygiene({ ...base, name: "x", command: "nope-not-here-xyz", disabled: true })).toEqual(
      [],
    );
    expect(hygiene({ ...base, name: "x", command: process.execPath })).toEqual([]);
  });
  it("groups unpinned packages into one finding per client", () => {
    const a = { ...base, name: "a", command: "npx", args: ["-y", "a"] };
    const b = { ...base, name: "b", command: "npx", args: ["-y", "b@latest"] };
    const c = { ...base, name: "c", command: "npx", args: ["-y", "c@1.0.0"] };
    const r = run([a, b, c], []);
    const unpinned = r.findings.filter((f) => f.id === "unpinned-package");
    expect(unpinned).toHaveLength(1);
    expect(unpinned[0]?.message).toContain("a, b");
  });
});

describe("analyze", () => {
  const heavy: ServerConfig = { ...base, name: "heavy" };
  const light: ServerConfig = { ...base, name: "light", args: ["l"] };
  const dup: ServerConfig = { ...base, name: "heavy-copy", scope: "project" };
  const probes: Array<[ServerConfig, ReturnType<typeof okProbe>]> = [
    [heavy, okProbe([tool("big", 6_000), tool("small", 200)])],
    [light, okProbe([tool("t", 300)])],
  ];

  it("totals tokens per client and flags heavy servers, bloated tools and duplicates", () => {
    const r = run([heavy, light, dup], probes);
    expect(r.clients[0]?.tokens).toBe(6_200 * 2 + 300);
    expect(r.clients[0]?.toolCount).toBe(5);
    expect(ids(r)).toEqual(
      expect.arrayContaining(["heavy-server", "bloated-tool", "duplicate-server"]),
    );
  });

  it("loads only the highest-precedence entry when names collide", () => {
    const user: ServerConfig = { ...heavy, name: "same", scope: "user" };
    const local: ServerConfig = { ...light, name: "same", scope: "local" };
    const r = run(
      [user, local],
      [
        [user, probes[0]![1]],
        [local, probes[1]![1]],
      ],
    );
    const c = r.clients[0]!;
    expect(c.tokens).toBe(300);
    expect(c.servers.find((s) => s.config.scope === "user")?.shadowedBy).toBe("local scope");
  });

  it("leaves servers awaiting approval out of totals, and lets the user-scope twin load", () => {
    const pendingS: ServerConfig = {
      ...heavy,
      client: "claude-code",
      scope: "project",
      pendingApproval: true,
    };
    const user: ServerConfig = { ...light, client: "claude-code", name: "heavy" };
    const r = run(
      [pendingS, user],
      [
        [pendingS, probes[0]![1]],
        [user, probes[1]![1]],
      ],
      { procEnv: { ENABLE_TOOL_SEARCH: "false" } },
    );
    const c = r.clients[0]!;
    expect(c.servers.find((s) => s.config.scope === "user")?.shadowedBy).toBeUndefined();
    expect(c.servers.find((s) => s.config.pendingApproval)?.effectiveTokens).toBeGreaterThan(0);
    expect(c.effectiveTokens).toBe(
      c.servers.find((s) => s.config.scope === "user")?.effectiveTokens,
    );
    expect(ids(r)).toContain("pending-approval");
  });

  it("applies client tool filters", () => {
    const t = [tool("a", 1), tool("b", 1), tool("c", 1)];
    expect(
      applyToolFilter(t, {
        ...base,
        name: "x",
        toolFilter: { include: ["a", "b"], exclude: ["b"] },
      }).map((x) => x.name),
    ).toEqual(["a"]);
    const filtered: ServerConfig = { ...light, toolFilter: { exclude: ["t"] } };
    expect(run([filtered], [[filtered, okProbe([tool("t", 300)])]]).clients[0]?.tokens).toBe(0);
  });

  it("counts unmeasured servers and keeps sign-in failures out of errors", () => {
    const auth: ServerConfig = {
      ...base,
      name: "remote",
      transport: "http",
      url: "https://r",
      command: undefined,
    };
    const broken: ServerConfig = { ...base, name: "broken", args: ["b"] };
    const r = run(
      [light, auth, broken],
      [
        [light, okProbe([tool("t", 300)])],
        [auth, failedProbe("auth")],
        [broken, failedProbe("error", "boom")],
      ],
    );
    expect(r.clients[0]?.unmeasured).toBe(2);
    expect(r.findings.find((f) => f.id === "needs-auth")?.severity).toBe("info");
    expect(r.findings.find((f) => f.id === "probe-failed")?.message).toContain("broken");
  });

  it("does not double count savings for a heavy, unused server", () => {
    const cc: ServerConfig = { ...heavy, client: "claude-code", alwaysLoad: true };
    // Claude Code recomputes tokens from the text it sends, so use real descriptions.
    const tools = Array.from({ length: 10 }, (_, i) =>
      tool(`t${i}`, 0, { description: "word ".repeat(800) }),
    );
    const r = run([cc], [[cc, okProbe(tools)]], { usage: new Map() });
    expect(ids(r)).toEqual(expect.arrayContaining(["heavy-server", "unused-server"]));
    const single = r.findings.find((f) => f.id === "heavy-server")?.savings ?? 0;
    expect(totalSavings(r.findings)).toBe(single);
  });

  it("uses deferred cost for Claude Code with Tool Search on", () => {
    const cc: ServerConfig = { ...heavy, client: "claude-code" };
    const r = run([cc], [[cc, okProbe([tool("big", 6_000, { description: "x".repeat(20_000) })])]]);
    const c = r.clients[0]!;
    expect(c.effectiveTokens).toBeLessThan(20);
    expect(c.tokens).toBeGreaterThan(500);
    expect(ids(r)).not.toContain("heavy-server");
  });

  it("reports Claude Code compatibility problems", () => {
    const cc: ServerConfig = { ...base, client: "claude-code", name: "s".repeat(80) };
    const r = run(
      [cc],
      [
        [
          cc,
          okProbe(
            [
              tool("t".repeat(50), 10),
              tool("bad_props", 10, {
                inputSchema: { type: "object", properties: { "has space": {} } },
              }),
              tool("union", 10, { inputSchema: { anyOf: [{ type: "object" }] } }),
              tool("verbose", 10, { description: "z".repeat(20_000) }),
            ],
            { instructions: "i".repeat(5_000) },
          ),
        ],
      ],
    );
    expect(ids(r)).toEqual(
      expect.arrayContaining([
        "tool-name-too-long",
        "invalid-property-names",
        "root-combinator",
        "description-truncated",
        "instructions-truncated",
      ]),
    );
  });

  it("flags tool names that break OpenAI function-name rules for non-Claude clients", () => {
    const s: ServerConfig = { ...light, name: "dots" };
    const r = run([s], [[s, okProbe([tool("files.read", 10), tool("ok_name", 10)])]]);
    expect(r.findings.find((f) => f.id === "tool-name-incompatible")?.message).toContain(
      "files.read",
    );
  });
});

describe("renderers", () => {
  it("render without leaking secrets", () => {
    const env = fixtureEnv();
    const { servers } = discover(env);
    const r = analyze({ env, servers, tokenizer: "t", checkPath: false, procEnv: {} });
    const out = renderTerminal(r) + renderJson(r) + renderMarkdown(r);
    expect(out).not.toContain("ghp_FAKEfakeFAKEfakeFAKEfake000000");
    expect(out).not.toContain("BSAabcdefghijklmnopqrstu");
    expect(out).toContain("Configs only (--static)");
  });

  it("shows unmeasured servers in the headline and statuses per row", () => {
    const ok: ServerConfig = { ...base, name: "ok-server" };
    const auth: ServerConfig = { ...base, name: "auth-server", args: ["a"] };
    const r = run(
      [ok, auth],
      [
        [ok, okProbe([tool("t", 100)])],
        [auth, failedProbe("auth")],
      ],
    );
    const text = renderTerminal(r);
    expect(text).toContain("+ 1 server not counted");
    expect(text).toContain("needs sign-in");
    const json = JSON.parse(renderJson(r));
    expect(json.clients[0].servers[1].probe.status).toBe("auth");
  });
});
