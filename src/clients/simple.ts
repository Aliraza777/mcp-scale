import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ClientId, ServerConfig } from "../types.js";
import type { Env } from "./env.js";
import { isRecord, type ParseOptions, parseServerMap, readJson, stringRecord } from "./util.js";

function fromJsonFiles(
  client: ClientId,
  key: string,
  files: Array<[string, ParseOptions["scope"]]>,
  bareUrl?: ParseOptions["bareUrl"],
): ServerConfig[] {
  return files.flatMap(([file, scope]) => {
    const json = readJson(file);
    return isRecord(json)
      ? parseServerMap(json[key], { client, scope, sourceFile: file, bareUrl })
      : [];
  });
}

export const cursor = (env: Env) =>
  fromJsonFiles("cursor", "mcpServers", [
    [join(env.home, ".cursor", "mcp.json"), "user"],
    [join(env.cwd, ".cursor", "mcp.json"), "project"],
  ]);

export const vscode = (env: Env) =>
  fromJsonFiles("vscode", "servers", [
    [join(env.appData, "Code", "User", "mcp.json"), "user"],
    [join(env.appData, "Code - Insiders", "User", "mcp.json"), "user"],
    [join(env.cwd, ".vscode", "mcp.json"), "project"],
  ]);

export const windsurf = (env: Env) =>
  fromJsonFiles("windsurf", "mcpServers", [
    [join(env.home, ".codeium", "windsurf", "mcp_config.json"), "user"],
  ]);

/** Gemini CLI: `httpUrl` is Streamable HTTP, a bare `url` is SSE. */
export const gemini = (env: Env) =>
  fromJsonFiles(
    "gemini",
    "mcpServers",
    [
      [join(env.home, ".gemini", "settings.json"), "user"],
      [join(env.cwd, ".gemini", "settings.json"), "project"],
    ],
    "sse",
  );

export function codex(env: Env): ServerConfig[] {
  const file = join(env.home, ".codex", "config.toml");
  if (!existsSync(file)) return [];
  const toml = parseToml(readFileSync(file, "utf8"));
  const raw = isRecord(toml.mcp_servers) ? toml.mcp_servers : {};
  const servers = parseServerMap(raw, { client: "codex", scope: "user", sourceFile: file });
  for (const s of servers) {
    const entry = raw[s.name];
    if (!isRecord(entry)) continue;
    const headers = { ...s.headers };
    if (typeof entry.bearer_token_env_var === "string")
      headers.Authorization = `Bearer \${${entry.bearer_token_env_var}}`;
    for (const [h, v] of Object.entries(stringRecord(entry.env_http_headers) ?? {}))
      headers[h] = `\${${v}}`;
    if (Object.keys(headers).length) s.headers = headers;
  }
  return servers;
}

export function claudeDesktop(env: Env): ServerConfig[] {
  const base = join(env.appData, "Claude");
  return [
    ...fromJsonFiles("claude-desktop", "mcpServers", [
      [join(base, "claude_desktop_config.json"), "user"],
    ]),
    ...desktopExtensions(base, env),
  ];
}

/**
 * Claude Desktop extensions (.mcpb/.dxt): each lives in `Claude Extensions/<id>/manifest.json`,
 * with per-extension settings (enabled flag, user config) in `Claude Extensions Settings/<id>.json`.
 */
function desktopExtensions(base: string, env: Env): ServerConfig[] {
  const dir = join(base, "Claude Extensions");
  if (!existsSync(dir)) return [];
  const servers: ServerConfig[] = [];
  for (const id of readdirSync(dir)) {
    const manifestFile = join(dir, id, "manifest.json");
    let manifest: unknown;
    try {
      manifest = readJson(manifestFile);
    } catch {
      continue;
    }
    if (!isRecord(manifest) || !isRecord(manifest.server)) continue;
    const mcp = manifest.server.mcp_config;
    if (!isRecord(mcp) || typeof mcp.command !== "string") continue;
    const settings = readJson(join(base, "Claude Extensions Settings", `${id}.json`));
    const userConfig =
      isRecord(settings) && isRecord(settings.userConfig) ? settings.userConfig : {};
    const defaults = isRecord(manifest.user_config) ? manifest.user_config : {};
    const sub = (v: string) =>
      v
        .replace(/\$\{__dirname\}/g, join(dir, id))
        .replace(/\$\{HOME\}/g, env.home)
        .replace(/\$\{(?:pathSeparator|\/)\}/g, env.platform === "win32" ? "\\" : "/")
        .replace(/\$\{user_config\.([^}]+)\}/g, (_, k: string) => {
          const value = userConfig[k] ?? (isRecord(defaults[k]) ? defaults[k].default : undefined);
          return value == null ? "" : Array.isArray(value) ? value.join(" ") : String(value);
        });
    const enabled = !isRecord(settings) || settings.isEnabled !== false;
    servers.push({
      name:
        typeof manifest.display_name === "string"
          ? manifest.display_name
          : typeof manifest.name === "string"
            ? manifest.name
            : id,
      client: "claude-desktop",
      scope: "extension",
      sourceFile: manifestFile,
      transport: "stdio",
      transportExplicit: true,
      command: sub(mcp.command),
      args: Array.isArray(mcp.args) ? mcp.args.map((a) => sub(String(a))) : undefined,
      env: Object.fromEntries(
        Object.entries(stringRecord(mcp.env) ?? {}).map(([k, v]) => [k, sub(v)]),
      ),
      disabled: !enabled,
      disabledReason: enabled ? undefined : "extension disabled",
    });
  }
  return servers;
}
