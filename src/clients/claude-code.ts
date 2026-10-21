import { dirname, join } from "node:path";
import type { ServerConfig } from "../types.js";
import type { Env } from "./env.js";
import { isRecord, parseServerMap, readJson } from "./util.js";

/** Settings files in increasing precedence: user, project, local. */
export function claudeSettingsFiles(env: Env): string[] {
  return [
    join(env.home, ".claude", "settings.json"),
    join(env.cwd, ".claude", "settings.json"),
    join(env.cwd, ".claude", "settings.local.json"),
  ];
}

export interface ClaudeSettings {
  scope: "user" | "project" | "local";
  data: Record<string, unknown>;
}

/** Existing settings files, each tagged with its scope, in increasing precedence. */
export function readClaudeSettings(env: Env): ClaudeSettings[] {
  const scopes = ["user", "project", "local"] as const;
  return claudeSettingsFiles(env).flatMap((f, i) => {
    try {
      const data = readJson(f);
      return isRecord(data) ? [{ scope: scopes[i] as ClaudeSettings["scope"], data }] : [];
    } catch {
      return [];
    }
  });
}

interface DenyEntry {
  serverName?: string;
  serverCommand?: string[];
  serverUrl?: string;
}

function urlPatternMatches(pattern: string, url: string): boolean {
  const re = new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}${pattern.includes("/", pattern.indexOf("//") + 2) ? "" : "(/.*)?"}$`,
    "i",
  );
  return re.test(url);
}

export function deniedBy(s: ServerConfig, entries: DenyEntry[]): DenyEntry | undefined {
  return entries.find((e) => {
    if (e.serverName !== undefined) return e.serverName === s.name;
    if (e.serverCommand && s.transport === "stdio")
      return JSON.stringify(e.serverCommand) === JSON.stringify([s.command, ...(s.args ?? [])]);
    if (e.serverUrl && s.url) return urlPatternMatches(e.serverUrl, s.url);
    return false;
  });
}

/** ~/.claude.json project entry for cwd, and whether cwd or an ancestor is trusted. */
function projectState(
  global: unknown,
  cwd: string,
): { entry?: Record<string, unknown>; trusted: boolean } {
  const projects = isRecord(global) && isRecord(global.projects) ? global.projects : {};
  const entry = isRecord(projects[cwd]) ? (projects[cwd] as Record<string, unknown>) : undefined;
  let trusted = false;
  for (let dir = cwd; ; dir = dirname(dir)) {
    const p = projects[dir];
    if (isRecord(p) && p.hasTrustDialogAccepted === true) trusted = true;
    if (dirname(dir) === dir) break;
  }
  return { entry, trusted };
}

export function claudeCode(env: Env): ServerConfig[] {
  const servers: ServerConfig[] = [];
  const globalFile = join(env.home, ".claude.json");
  const global = readJson(globalFile);
  const settings = readClaudeSettings(env);
  const { entry: projectEntry, trusted } = projectState(global, env.cwd);
  const disabledProject = new Set<string>();
  const enabledProject = new Set<string>();
  let enableAll = false;
  const denied: DenyEntry[] = [];
  for (const { scope, data: s } of settings) {
    if (Array.isArray(s.disabledMcpjsonServers))
      for (const n of s.disabledMcpjsonServers) disabledProject.add(String(n));
    if (Array.isArray(s.deniedMcpServers)) denied.push(...s.deniedMcpServers.filter(isRecord));
    // Approvals in project/local settings are ignored until the folder is trusted.
    if (scope !== "user" && !trusted) continue;
    if (s.enableAllProjectMcpServers === true) enableAll = true;
    if (Array.isArray(s.enabledMcpjsonServers))
      for (const n of s.enabledMcpjsonServers) enabledProject.add(String(n));
  }
  for (const n of Array.isArray(projectEntry?.enabledMcpjsonServers)
    ? projectEntry.enabledMcpjsonServers
    : [])
    enabledProject.add(String(n));

  if (isRecord(global)) {
    servers.push(
      ...parseServerMap(global.mcpServers, {
        client: "claude-code",
        scope: "user",
        sourceFile: globalFile,
      }),
    );
    const project = projectEntry;
    if (project) {
      servers.push(
        ...parseServerMap(project.mcpServers, {
          client: "claude-code",
          scope: "local",
          sourceFile: globalFile,
        }),
      );
      if (Array.isArray(project.disabledMcpjsonServers))
        for (const n of project.disabledMcpjsonServers) disabledProject.add(String(n));
    }
  }

  const projectFile = join(env.cwd, ".mcp.json");
  const projectJson = readJson(projectFile);
  if (isRecord(projectJson)) {
    for (const s of parseServerMap(projectJson.mcpServers, {
      client: "claude-code",
      scope: "project",
      sourceFile: projectFile,
    })) {
      if (disabledProject.has(s.name)) {
        s.disabled = true;
        s.disabledReason = "listed in disabledMcpjsonServers";
      } else if (!enableAll && !enabledProject.has(s.name)) s.pendingApproval = true;
      servers.push(s);
    }
  }

  // managed-mcp.json takes exclusive control: nothing else loads.
  const managedFile = env.managedMcpFile;
  const managed = readJson(managedFile);
  if (isRecord(managed)) {
    for (const s of servers) {
      s.disabled = true;
      s.disabledReason = "blocked: managed-mcp.json has exclusive control";
    }
    servers.unshift(
      ...parseServerMap(managed.mcpServers, {
        client: "claude-code",
        scope: "managed",
        sourceFile: managedFile,
      }),
    );
  }

  for (const s of servers) {
    const hit = !s.disabled && deniedBy(s, denied);
    if (hit) {
      s.disabled = true;
      s.disabledReason = "blocked by deniedMcpServers";
    }
  }
  return servers;
}
