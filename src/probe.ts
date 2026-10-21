import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ElicitRequestSchema, ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { estimateToolTokens } from "./tokens.js";
import type { ProbeResult, ProbeStatus, ServerConfig, ToolInfo } from "./types.js";

/** Same server configured in several clients is only started once. */
export function configKey(s: ServerConfig): string {
  const id =
    s.transport === "stdio"
      ? { c: s.command, a: s.args ?? [], e: s.env ?? {}, d: s.cwd }
      : { u: s.url, h: s.headers ?? {} };
  return createHash("sha1").update(JSON.stringify(id)).digest("hex").slice(0, 12);
}

export interface VarContext {
  env: Record<string, string | undefined>;
  home?: string;
  cwd?: string;
}

/**
 * Expand placeholders used across clients: `${VAR}`, `${VAR:-default}` (Claude Code),
 * `${env:VAR}`, `${userHome}`, `${workspaceFolder}` (Cursor, VS Code). `${input:…}` prompts
 * can't be answered outside the editor and expand to an empty string.
 */
export function expandVars(value: string, ctx: VarContext): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    if (expr === "userHome") return ctx.home ?? "";
    if (expr === "workspaceFolder" || expr === "workspaceRoot") return ctx.cwd ?? "";
    if (expr === "workspaceFolderBasename") return (ctx.cwd ?? "").split(/[\\/]/).pop() ?? "";
    if (expr === "pathSeparator" || expr === "/") return process.platform === "win32" ? "\\" : "/";
    if (expr.startsWith("input:")) return "";
    const m = /^(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?$/.exec(expr);
    if (!m) return "";
    const [, name = "", def] = m;
    return ctx.env[name] || (def ?? "");
  });
}

/** Keeps the tail of a child's stderr so a crash can be explained. */
class StderrTail {
  private buf = "";
  push(chunk: Buffer | string) {
    this.buf = (this.buf + chunk.toString()).slice(-4_000);
  }
  /** The most informative stderr line (an error if there is one), ANSI stripped. */
  summary(): string | undefined {
    const lines = this.buf
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI escapes
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/complete log of this run|^at\s|^\^+$|^npm (error|ERR!) *$/i.test(l));
    if (!lines.length) return undefined;
    const important =
      lines.find((l) =>
        /\b(404|ENOENT|EACCES|not found|cannot find|no such file|ModuleNotFoundError|command not found)\b/i.test(
          l,
        ),
      ) ??
      lines.findLast((l) =>
        /error|exception|fatal|traceback|failed|denied|missing|required/i.test(l),
      ) ??
      lines[lines.length - 1];
    return important?.slice(0, 240);
  }
}

function createTransport(
  s: ServerConfig,
  kind: ServerConfig["transport"],
  ctx: VarContext,
  stderr: StderrTail,
): Transport {
  if (kind === "stdio") {
    const childEnv = { ...getDefaultEnvironment() };
    for (const [k, v] of Object.entries(s.env ?? {})) childEnv[k] = expandVars(v, ctx);
    const transport = new StdioClientTransport({
      command: expandVars(s.command ?? "", ctx),
      args: (s.args ?? []).map((a) => expandVars(a, ctx)),
      env: childEnv,
      cwd: s.cwd ? expandVars(s.cwd, ctx) : undefined,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (c) => stderr.push(c));
    return transport;
  }
  const headers = Object.fromEntries(
    Object.entries(s.headers ?? {}).map(([k, v]) => [k, expandVars(v, ctx)]),
  );
  const url = new URL(expandVars(s.url ?? "", ctx));
  return kind === "sse"
    ? new SSEClientTransport(url, { requestInit: { headers } })
    : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
}

async function listAll<T>(fetchPage: (cursor?: string) => Promise<{ items: T[]; next?: string }>) {
  const all: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const { items, next } = await fetchPage(cursor);
    all.push(...items);
    if (!next || next === cursor) break;
    cursor = next;
  }
  return all;
}

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new TimeoutError(`${what} timed out after ${ms / 1000}s`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

const AUTH_PATTERN =
  /\b(401|403)\b|unauthori[sz]ed|forbidden|authori[sz]ation|authenticat|invalid[_ ]token|api[_ -]?key|oauth|no auth provider/i;

export function classifyError(e: unknown): { status: ProbeStatus; message: string } {
  const message = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
  if (e instanceof TimeoutError) return { status: "timeout", message };
  const code = (e as { code?: unknown })?.code;
  if (
    code === 401 ||
    code === 403 ||
    e?.constructor?.name === "UnauthorizedError" ||
    AUTH_PATTERN.test(message)
  )
    return {
      status: "auth",
      message:
        message.replace(/^Streamable HTTP error: Error POSTing to endpoint:\s*$/, "") ||
        `HTTP ${typeof code === "number" ? code : 401}`,
    };
  return {
    status: "error",
    message: message || (typeof code === "number" ? `HTTP ${code}` : "unknown error"),
  };
}

/** Streamable HTTP rejected the request in a way that suggests an SSE-only server. */
const looksLikeSseOnly = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  return (
    code === 404 ||
    code === 405 ||
    /method not allowed|not found|404|405/i.test(String((e as Error)?.message))
  );
};

/**
 * A client that declares roots and elicitation like Claude Code, Cursor and VS Code do. Some
 * servers only register tools for clients with these capabilities, so declaring none would
 * undercount them.
 */
function createClient(ctx: VarContext): Client {
  const client = new Client(
    { name: "mcp-scale", version: "0.1.0" },
    { capabilities: { roots: { listChanged: false }, elicitation: {} } },
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: ctx.cwd ? [{ uri: pathToFileURL(ctx.cwd).href, name: "workspace" }] : [],
  }));
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "decline" }));
  return client;
}

export interface ProbeOptions {
  timeoutMs?: number;
  ctx?: VarContext;
}

export async function probe(s: ServerConfig, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const ctx = opts.ctx ?? { env: process.env };
  const started = Date.now();
  const empty = { tools: [], prompts: 0, resources: 0 };
  if (s.unsupported)
    return { status: "error", ok: false, error: s.unsupported, ...empty, latencyMs: 0 };

  const attempts: ServerConfig["transport"][] =
    s.transport === "http" && !s.transportExplicit ? ["http", "sse"] : [s.transport];
  let lastError: unknown;
  const stderr = new StderrTail();

  for (const kind of attempts) {
    const client = createClient(ctx);
    try {
      await withTimeout(
        client.connect(createTransport(s, kind, ctx, stderr)),
        timeoutMs,
        "connect",
      );
      const caps = client.getServerCapabilities() ?? {};
      const rawTools = caps.tools
        ? await withTimeout(
            listAll(async (cursor) => {
              const r = await client.listTools(cursor ? { cursor } : undefined);
              return { items: r.tools, next: r.nextCursor };
            }),
            timeoutMs,
            "tools/list",
          )
        : [];
      const tools: ToolInfo[] = rawTools.map((t) => {
        const meta = (t as { _meta?: Record<string, unknown> })._meta;
        const alwaysLoad = meta?.["anthropic/alwaysLoad"];
        return {
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          alwaysLoad: typeof alwaysLoad === "boolean" ? alwaysLoad : undefined,
          tokens: estimateToolTokens(t),
        };
      });
      const count = async (has: unknown, list: () => Promise<number>) =>
        has ? withTimeout(list(), 5_000, "list").catch(() => 0) : 0;
      const prompts = await count(caps.prompts, () =>
        client.listPrompts().then((r) => r.prompts.length),
      );
      const resources = await count(caps.resources, () =>
        client.listResources().then((r) => r.resources.length),
      );
      const info = client.getServerVersion();
      return {
        status: "ok",
        ok: true,
        serverName: info?.name,
        serverVersion: info?.version,
        instructions: client.getInstructions(),
        tools,
        prompts,
        resources,
        latencyMs: Date.now() - started,
        transportUsed: kind,
      };
    } catch (e) {
      lastError = e;
      if (!(kind === "http" && attempts.length > 1 && looksLikeSseOnly(e))) break;
    } finally {
      await client.close().catch(() => {});
    }
  }

  const { status, message } = classifyError(lastError);
  const tail = s.transport === "stdio" ? stderr.summary() : undefined;
  return {
    status,
    ok: false,
    error: tail && status !== "auth" ? `${message} — stderr: ${tail}` : message,
    ...empty,
    latencyMs: Date.now() - started,
  };
}

export async function probeAll(
  servers: ServerConfig[],
  opts: ProbeOptions & {
    concurrency?: number;
    onDone?: (s: ServerConfig, r: ProbeResult) => void;
  } = {},
): Promise<Map<string, ProbeResult>> {
  const unique = new Map<string, ServerConfig>();
  for (const s of servers)
    if (!s.disabled && !unique.has(configKey(s))) unique.set(configKey(s), s);
  const results = new Map<string, ProbeResult>();
  const queue = [...unique.entries()];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [key, s] = next;
      const r = await probe(s, opts);
      results.set(key, r);
      opts.onDone?.(s, r);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 6) }, worker));
  return results;
}
