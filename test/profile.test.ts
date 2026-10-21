import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discover } from "../src/clients/index.js";
import {
  applyProfile,
  listProfiles,
  loadProfile,
  restore,
  saveProfile,
  toClientEntry,
} from "../src/profile.js";
import type { ServerConfig } from "../src/types.js";
import { tempEnv, write } from "./helpers.js";

describe("profiles", () => {
  it("saves, lists and loads, rejecting path-like names", () => {
    const env = tempEnv();
    saveProfile(env, { name: "web", keep: ["github", "sentry"] });
    expect(listProfiles(env)).toEqual([{ name: "web", keep: ["github", "sentry"] }]);
    expect(() => loadProfile(env, "nope")).toThrow(/No profile/);
    expect(() => saveProfile(env, { name: "../evil", keep: [] })).toThrow();
  });

  it("applies to a new Cursor project config and restores it", () => {
    const env = tempEnv();
    const file = join(env.cwd, ".cursor", "mcp.json");
    const res = applyProfile(
      env,
      { name: "p", keep: ["github", "sentry", "ghost"] },
      "cursor",
      discover(env).servers,
    );
    expect(res).toMatchObject({
      written: file,
      kept: ["github", "sentry"],
      missing: ["ghost"],
      stillLoaded: ["remote"],
    });
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(written.mcpServers)).toEqual(["github", "sentry"]);
    expect(written.mcpServers.sentry).toEqual({ url: "https://mcp.sentry.dev/sse" });
    restore(env);
    expect(existsSync(file)).toBe(false);
  });

  it("prunes user-level servers when asked and restores the original bytes", () => {
    const env = tempEnv();
    const userFile = join(env.home, ".cursor", "mcp.json");
    const before = readFileSync(userFile, "utf8");
    const res = applyProfile(
      env,
      { name: "p", keep: ["github"] },
      "cursor",
      discover(env).servers,
      { pruneUser: true },
    );
    expect(res.pruned).toEqual(["remote"]);
    expect(Object.keys(JSON.parse(readFileSync(userFile, "utf8")).mcpServers)).toEqual(["github"]);
    restore(env);
    expect(readFileSync(userFile, "utf8")).toBe(before);
  });

  it("prunes Claude Code local-scope servers from ~/.claude.json and keeps other keys", () => {
    const env = tempEnv({ empty: true });
    const claudeJson = write(env, "~/.claude.json", {
      numStartups: 42,
      mcpServers: { keep: { command: "a" }, drop: { command: "b" } },
      projects: { [env.cwd]: { mcpServers: { localDrop: { command: "c" } }, allowedTools: [] } },
    });
    const res = applyProfile(
      env,
      { name: "p", keep: ["keep"] },
      "claude-code",
      discover(env).servers,
      { pruneUser: true },
    );
    expect(res.pruned.sort()).toEqual(["drop", "localDrop"]);
    const after = JSON.parse(readFileSync(claudeJson, "utf8"));
    expect(after.numStartups).toBe(42);
    expect(after.projects[env.cwd]).toEqual({ mcpServers: {}, allowedTools: [] });
    expect(JSON.parse(readFileSync(join(env.cwd, ".mcp.json"), "utf8")).mcpServers).toEqual({
      keep: { command: "a" },
    });
  });

  it("never prunes managed servers", () => {
    const env = tempEnv({ empty: true });
    write(env, env.managedMcpFile, {
      mcpServers: { corp: { type: "http", url: "https://c/mcp" } },
    });
    const res = applyProfile(env, { name: "p", keep: [] }, "claude-code", discover(env).servers, {
      pruneUser: true,
    });
    expect(res.pruned).toEqual([]);
    expect(existsSync(env.managedMcpFile)).toBe(true);
  });

  it("keeps other keys when writing an existing Gemini settings.json", () => {
    const env = tempEnv({ empty: true });
    write(env, "./.gemini/settings.json", { theme: "dark", mcpServers: { old: { command: "x" } } });
    write(env, "~/.cursor/mcp.json", { mcpServers: { api: { url: "https://api/mcp" } } });
    applyProfile(env, { name: "p", keep: ["api"] }, "gemini", discover(env).servers);
    expect(JSON.parse(readFileSync(join(env.cwd, ".gemini", "settings.json"), "utf8"))).toEqual({
      theme: "dark",
      mcpServers: { api: { httpUrl: "https://api/mcp" } },
    });
  });

  it("rejects clients without a project config", () => {
    const env = tempEnv();
    expect(() => applyProfile(env, { name: "p", keep: [] }, "windsurf", [])).toThrow(
      /no project-level/,
    );
  });

  it("restore fails cleanly with nothing to restore", () => {
    expect(() => restore(tempEnv({ empty: true }))).toThrow(/No backup/);
  });

  it("serializes per client format", () => {
    const s: ServerConfig = {
      name: "x",
      client: "cursor",
      scope: "user",
      sourceFile: "f",
      transport: "stdio",
      command: "npx",
      args: ["a"],
    };
    expect(toClientEntry(s, "vscode")).toEqual({ type: "stdio", command: "npx", args: ["a"] });
    expect(toClientEntry(s, "cursor")).toEqual({ command: "npx", args: ["a"] });
    const h: ServerConfig = {
      ...s,
      transport: "http",
      command: undefined,
      args: undefined,
      url: "https://u",
      alwaysLoad: true,
    };
    expect(toClientEntry(h, "claude-code")).toEqual({
      type: "http",
      url: "https://u",
      alwaysLoad: true,
    });
  });
});
