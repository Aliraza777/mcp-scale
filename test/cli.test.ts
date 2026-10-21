import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FAKE_SERVER, TSX, tempEnv, write } from "./helpers.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function cli(env: ReturnType<typeof tempEnv>, args: string[]) {
  const r = spawnSync(process.execPath, ["--import", TSX, CLI, ...args], {
    cwd: env.cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: env.home,
      USERPROFILE: env.home,
      APPDATA: env.appData,
      XDG_CONFIG_HOME: env.appData,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const fakeEntry = { command: process.execPath, args: ["--import", TSX, FAKE_SERVER] };

describe("cli", () => {
  it("reports the version from package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(cli(tempEnv({ empty: true }), ["--version"]).out.trim()).toBe(pkg.version);
  }, 60_000);

  it("prints a static JSON report and exits 0", () => {
    const env = tempEnv({ empty: true });
    write(env, "~/.cursor/mcp.json", { mcpServers: { fake: fakeEntry } });
    const r = cli(env, ["--static", "-f", "json"]);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out);
    expect(json.probed).toBe(false);
    expect(json.clients[0].servers[0].config.name).toBe("fake");
  }, 60_000);

  it("falls back to a static scan without a TTY unless --yes is given", () => {
    const env = tempEnv({ empty: true });
    write(env, "~/.cursor/mcp.json", { mcpServers: { fake: fakeEntry } });
    const r = cli(env, []);
    expect(r.code).toBe(0);
    expect(r.err).toContain("Not a TTY");
    expect(r.out).toContain("no terminal to ask for permission");
  }, 60_000);

  it("connects with --yes and counts tokens", () => {
    const env = tempEnv({ empty: true });
    write(env, "~/.cursor/mcp.json", { mcpServers: { fake: fakeEntry } });
    const json = JSON.parse(cli(env, ["--yes", "-f", "json"]).out);
    expect(json.probed).toBe(true);
    expect(json.clients[0].toolCount).toBe(3);
    expect(json.clients[0].tokens).toBeGreaterThan(500);
    const text = cli(env, ["--yes"]).out;
    expect(text).toMatch(/Cursor\s+3 tools · [\d,]+ tokens in every request/);
  }, 60_000);

  it("lists a server's tools heaviest first", () => {
    const env = tempEnv({ empty: true });
    write(env, "~/.cursor/mcp.json", { mcpServers: { fake: fakeEntry } });
    const r = cli(env, ["tools", "fake"]);
    expect(r.code).toBe(0);
    const order = ["tool_2", "tool_1", "tool_0"].map((t) => r.out.indexOf(t));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(r.out).toContain("server instructions");
  }, 60_000);

  it("explains an unknown server name", () => {
    const env = tempEnv({ empty: true });
    write(env, "~/.cursor/mcp.json", { mcpServers: { fake: fakeEntry } });
    const r = cli(env, ["tools", "nope"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Known servers: fake");
  }, 60_000);

  it("ci passes under budget, fails over budget, on secrets and on unmeasured servers", () => {
    const env = tempEnv({ empty: true });
    write(env, "./.mcp.json", { mcpServers: { fake: fakeEntry } });
    write(env, "~/.cursor/mcp.json", { mcpServers: { ignored: { command: "nope-xyz" } } });
    expect(cli(env, ["ci", "--max-tokens", "100000"]).code).toBe(0);
    const over = cli(env, ["ci", "--max-tokens", "1"]);
    expect(over.code).toBe(1);
    expect(over.err).toContain("> budget 1");

    write(env, "./.mcp.json", {
      mcpServers: {
        fake: { ...fakeEntry, env: { GITHUB_TOKEN: "ghp_FAKEfakeFAKEfakeFAKEfake000000" } },
      },
    });
    expect(cli(env, ["ci", "--max-tokens", "100000"]).err).toContain("Hardcoded secret");

    write(env, "./.mcp.json", {
      mcpServers: {
        broken: { command: process.execPath, args: ["--import", TSX, FAKE_SERVER, "--crash"] },
      },
    });
    expect(cli(env, ["ci", "--max-tokens", "100000"]).code).toBe(1);
    expect(cli(env, ["ci", "--max-tokens", "100000", "--allow-unmeasured"]).code).toBe(0);
  }, 120_000);

  it("rejects bad option values", () => {
    const env = tempEnv({ empty: true });
    expect(cli(env, ["--timeout", "abc"]).code).toBe(1);
    expect(cli(env, ["ci", "--max-tokens", "-5"]).code).toBe(1);
    expect(cli(env, ["-c", "notaclient"]).code).toBe(1);
  }, 60_000);

  it("profile create → apply → restore round trip", () => {
    const env = tempEnv({ empty: true });
    write(env, "~/.cursor/mcp.json", { mcpServers: { a: { command: "x" }, b: { command: "y" } } });
    expect(cli(env, ["profile", "create", "web", "--keep", "a,missing"]).out).toContain(
      "Not found in any config right now: missing",
    );
    const apply = cli(env, ["profile", "apply", "web", "-c", "cursor"]);
    expect(apply.code).toBe(0);
    expect(apply.out).toContain("Still loaded in every project from the user-level config: b");
    const file = join(env.cwd, ".cursor", "mcp.json");
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).mcpServers)).toEqual(["a"]);
    expect(cli(env, ["restore"]).code).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(cli(env, ["profile", "list"]).out).toContain("web  a, missing");
  }, 60_000);

  it("says so when nothing is configured", () => {
    const r = cli(tempEnv({ empty: true }), ["--static"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("No MCP servers found");
  }, 60_000);
});
