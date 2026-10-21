import { existsSync, readFileSync } from "node:fs";
import type { ClientId, Scope, ServerConfig } from "../types.js";

export function readJson(file: string): unknown {
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // VS Code and some others allow JSONC
    try {
      return JSON.parse(stripJsonComments(text));
    } catch (e) {
      throw new Error(`Invalid JSON in ${file}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  // trailing commas
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const stringRecord = (v: unknown): Record<string, string> | undefined => {
  if (!isRecord(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (val != null) out[k] = String(val);
  return out;
};

const stringList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(String) : undefined;

export interface ParseOptions {
  client: ClientId;
  scope: Scope;
  sourceFile: string;
  /** How a bare `url` with no `type` is interpreted. Gemini uses `url` for SSE. */
  bareUrl?: "http" | "sse";
}

/** Normalize the common `{ name: { command, args, env } | { url, headers } }` shape. */
export function parseServerMap(map: unknown, opts: ParseOptions): ServerConfig[] {
  if (!isRecord(map)) return [];
  const { bareUrl = "http", ...base } = opts;
  const servers: ServerConfig[] = [];
  for (const [name, raw] of Object.entries(map)) {
    if (!isRecord(raw)) continue;
    const type = typeof raw.type === "string" ? raw.type.toLowerCase() : undefined;
    const command = typeof raw.command === "string" ? raw.command : undefined;
    const httpUrl = typeof raw.httpUrl === "string" ? raw.httpUrl : undefined;
    const url =
      httpUrl ??
      (typeof raw.url === "string" ? raw.url : undefined) ??
      (typeof raw.serverUrl === "string" ? raw.serverUrl : undefined);

    let transport: ServerConfig["transport"];
    let unsupported: string | undefined;
    if (command && type !== "http" && type !== "sse") transport = "stdio";
    else if (type === "sse") transport = "sse";
    else if (type === "http" || type === "streamable-http" || type === "streamablehttp" || httpUrl)
      transport = "http";
    else if (type === "ws" || type === "websocket" || type === "sdk") {
      transport = "http";
      unsupported = `${type} transport is not supported by mcp-scale`;
    } else if (url) transport = bareUrl;
    else continue;
    if (transport !== "stdio" && !url && !unsupported) continue;

    const include = stringList(raw.includeTools ?? raw.enabled_tools);
    const exclude = stringList(raw.excludeTools ?? raw.disabled_tools);
    servers.push({
      ...base,
      name,
      transport,
      transportExplicit: transport === "stdio" || type !== undefined || httpUrl !== undefined,
      command: transport === "stdio" ? command : undefined,
      args: transport === "stdio" ? stringList(raw.args) : undefined,
      env: stringRecord(raw.env),
      cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
      url: transport === "stdio" ? undefined : url,
      headers: stringRecord(raw.headers ?? raw.http_headers),
      disabled: raw.disabled === true || raw.enabled === false,
      disabledReason:
        raw.disabled === true || raw.enabled === false ? "disabled in config" : undefined,
      alwaysLoad: typeof raw.alwaysLoad === "boolean" ? raw.alwaysLoad : undefined,
      toolFilter: include || exclude ? { include, exclude } : undefined,
      unsupported,
    });
  }
  return servers;
}
