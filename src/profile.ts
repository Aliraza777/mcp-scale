import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Env } from "./clients/env.js";
import { isRecord, readJson } from "./clients/util.js";
import type { ClientId, ServerConfig } from "./types.js";

export interface Profile {
  name: string;
  keep: string[];
}

const stateDir = (env: Env) => join(env.home, ".mcp-scale");
const profilePath = (env: Env, name: string) => join(stateDir(env), "profiles", `${name}.json`);

export function saveProfile(env: Env, profile: Profile): string {
  if (!/^[\w.-]+$/.test(profile.name)) throw new Error(`Invalid profile name "${profile.name}"`);
  const file = profilePath(env, profile.name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`);
  return file;
}

export function loadProfile(env: Env, name: string): Profile {
  const json = readJson(profilePath(env, name));
  if (!isRecord(json) || !Array.isArray(json.keep))
    throw new Error(`No profile named "${name}". See: mcp-scale profile list`);
  return { name, keep: json.keep.map(String) };
}

export function listProfiles(env: Env): Profile[] {
  const dir = join(stateDir(env), "profiles");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => loadProfile(env, f.slice(0, -5)));
}

/** Where each client reads project-scoped servers, and under which key. */
const PROJECT_TARGETS: Partial<Record<ClientId, { file: (cwd: string) => string; key: string }>> = {
  "claude-code": { file: (cwd) => join(cwd, ".mcp.json"), key: "mcpServers" },
  cursor: { file: (cwd) => join(cwd, ".cursor", "mcp.json"), key: "mcpServers" },
  vscode: { file: (cwd) => join(cwd, ".vscode", "mcp.json"), key: "servers" },
  gemini: { file: (cwd) => join(cwd, ".gemini", "settings.json"), key: "mcpServers" },
};

export const PROFILE_CLIENTS = Object.keys(PROJECT_TARGETS) as ClientId[];

/** Serialize a normalized server back into the target client's config format. */
export function toClientEntry(s: ServerConfig, client: ClientId): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  if (s.transport === "stdio") {
    if (client === "vscode") entry.type = "stdio";
    entry.command = s.command;
    if (s.args?.length) entry.args = s.args;
    if (s.env && Object.keys(s.env).length) entry.env = s.env;
    if (s.cwd) entry.cwd = s.cwd;
  } else {
    if (client === "claude-code" || client === "vscode") entry.type = s.transport;
    entry[client === "gemini" && s.transport === "http" ? "httpUrl" : "url"] = s.url;
    if (s.headers && Object.keys(s.headers).length) entry.headers = s.headers;
  }
  if (client === "claude-code" && s.alwaysLoad !== undefined) entry.alwaysLoad = s.alwaysLoad;
  return entry;
}

function backup(env: Env, files: string[]): string {
  const dir = join(stateDir(env), "backups", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const manifest = files.map((file, i) => {
    const existed = existsSync(file);
    if (existed) copyFileSync(file, join(dir, `${i}.bak`));
    return { file, existed, copy: `${i}.bak` };
  });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

export interface ApplyResult {
  written: string;
  kept: string[];
  missing: string[];
  stillLoaded: string[];
  pruned: string[];
  backupDir: string;
}

/**
 * Write the profile's servers to the client's project config. User-scoped servers outside the
 * profile keep loading everywhere unless `pruneUser` removes them from the user config.
 */
export function applyProfile(
  env: Env,
  profile: Profile,
  client: ClientId,
  allServers: ServerConfig[],
  opts: { pruneUser?: boolean } = {},
): ApplyResult {
  const target = PROJECT_TARGETS[client];
  if (!target)
    throw new Error(
      `${client} has no project-level MCP config. Supported: ${PROFILE_CLIENTS.join(", ")}`,
    );
  const file = target.file(env.cwd);

  const byName = new Map<string, ServerConfig>();
  // Prefer a definition from the target client, then any other client.
  for (const s of [...allServers].sort(
    (a, b) => Number(b.client === client) - Number(a.client === client),
  ))
    if (!byName.has(s.name)) byName.set(s.name, s);
  const kept = profile.keep.filter((n) => byName.has(n));
  const missing = profile.keep.filter((n) => !byName.has(n));

  const userServers = allServers.filter(
    (s) => s.client === client && (s.scope === "user" || s.scope === "local"),
  );
  const outside = userServers.filter((s) => !profile.keep.includes(s.name));
  const pruneFiles = opts.pruneUser ? [...new Set(outside.map((s) => s.sourceFile))] : [];
  const backupDir = backup(env, [file, ...pruneFiles]);

  const existing = readJson(file);
  const doc: Record<string, unknown> = isRecord(existing) ? existing : {};
  doc[target.key] = Object.fromEntries(
    kept.map((n) => [n, toClientEntry(byName.get(n) as ServerConfig, client)]),
  );
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);

  const pruned: string[] = [];
  for (const source of pruneFiles) {
    const json = readJson(source);
    if (!isRecord(json)) continue;
    for (const s of outside.filter((o) => o.sourceFile === source)) {
      const map =
        s.scope === "local" && isRecord(json.projects)
          ? (json.projects as Record<string, unknown>)[env.cwd]
          : json;
      const servers = isRecord(map)
        ? map[client === "vscode" ? "servers" : "mcpServers"]
        : undefined;
      if (isRecord(servers) && s.name in servers) {
        delete servers[s.name];
        pruned.push(s.name);
      }
    }
    writeFileSync(source, `${JSON.stringify(json, null, 2)}\n`);
  }

  return {
    written: file,
    kept,
    missing,
    stillLoaded: opts.pruneUser ? [] : outside.map((s) => s.name),
    pruned,
    backupDir,
  };
}

/** Undo the most recent apply (or a given backup directory). */
export function restore(env: Env, backupDir?: string): { dir: string; files: string[] } {
  const root = join(stateDir(env), "backups");
  const dir =
    backupDir ??
    (existsSync(root)
      ? readdirSync(root)
          .sort()
          .map((d) => join(root, d))
          .pop()
      : undefined);
  if (!dir || !existsSync(join(dir, "manifest.json"))) throw new Error("No backup to restore.");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Array<{
    file: string;
    existed: boolean;
    copy: string;
  }>;
  for (const m of manifest) {
    if (m.existed) copyFileSync(join(dir, m.copy), m.file);
    else rmSync(m.file, { force: true });
  }
  rmSync(dir, { recursive: true, force: true });
  return { dir, files: manifest.map((m) => m.file) };
}
