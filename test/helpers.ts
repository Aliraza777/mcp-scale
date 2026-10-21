import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/clients/env.js";
import type { ProbeResult, ServerConfig, ToolInfo } from "../src/types.js";

export const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
export const FAKE_SERVER = join(FIXTURES, "fake-server.ts");
/** Absolute tsx loader URL, so child processes work from any working directory. */
export const TSX = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;

/** Fixture env using macOS paths, so results don't depend on the host OS. */
export function fixtureEnv(overrides: Partial<Env> = {}): Env {
  const home = join(FIXTURES, "home");
  return {
    home,
    cwd: join(FIXTURES, "project"),
    platform: "darwin",
    appData: join(home, "Library", "Application Support"),
    managedMcpFile: join(FIXTURES, "no-managed-mcp.json"),
    ...overrides,
  };
}

/** Writable copy of the fixtures for tests that modify configs. */
export function tempEnv(opts: { empty?: boolean } = {}): Env {
  const root = mkdtempSync(join(tmpdir(), "mcp-scale-"));
  if (!opts.empty) cpSync(FIXTURES, root, { recursive: true });
  const home = join(root, "home");
  mkdirSync(join(root, "project"), { recursive: true });
  return {
    home,
    cwd: join(root, "project"),
    platform: "darwin",
    appData: join(home, "Library", "Application Support"),
    managedMcpFile: join(root, "system", "managed-mcp.json"),
  };
}

/** Write a config file; `~` is the env's home and `.` its project directory. */
export function write(env: Env, path: string, content: unknown): string {
  const file = path.startsWith("~/")
    ? join(env.home, path.slice(2))
    : path.startsWith("./")
      ? join(env.cwd, path.slice(2))
      : path;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return file;
}

export const stdioFake = (overrides: Partial<ServerConfig> = {}): ServerConfig => ({
  name: "fake",
  client: "cursor",
  scope: "user",
  sourceFile: "x",
  transport: "stdio",
  transportExplicit: true,
  command: process.execPath,
  args: ["--import", TSX, FAKE_SERVER],
  ...overrides,
});

export const tool = (name: string, tokens: number, extra: Partial<ToolInfo> = {}): ToolInfo => ({
  name,
  tokens,
  description: "d",
  ...extra,
});

export const okProbe = (tools: ToolInfo[], extra: Partial<ProbeResult> = {}): ProbeResult => ({
  status: "ok",
  ok: true,
  tools,
  prompts: 0,
  resources: 0,
  latencyMs: 1,
  ...extra,
});

export const failedProbe = (status: ProbeResult["status"], error = "x"): ProbeResult => ({
  status,
  ok: false,
  error,
  tools: [],
  prompts: 0,
  resources: 0,
  latencyMs: 1,
});
