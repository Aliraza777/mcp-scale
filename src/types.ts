export type ClientId =
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "vscode"
  | "windsurf"
  | "codex"
  | "gemini";

export type Scope = "managed" | "local" | "project" | "user" | "extension";

export interface ServerConfig {
  name: string;
  client: ClientId;
  scope: Scope;
  sourceFile: string;
  transport: "stdio" | "http" | "sse";
  /** False when the config gave no explicit type, so the client would try HTTP then SSE. */
  transportExplicit?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  disabledReason?: string;
  /** Claude Code: a .mcp.json server the user hasn't approved yet, so it doesn't load. */
  pendingApproval?: boolean;
  /** Claude Code: load this server's tools up front (true) or always defer them (false). */
  alwaysLoad?: boolean;
  /** Client-side tool allow/deny lists (Gemini includeTools/excludeTools, Codex enabled_tools/disabled_tools). */
  toolFilter?: { include?: string[]; exclude?: string[] };
  /** Set when the transport can't be probed (e.g. websocket). */
  unsupported?: string;
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
  /** Server-declared `_meta["anthropic/alwaysLoad"]`. */
  alwaysLoad?: boolean;
  /** o200k estimate of the full definition. */
  tokens: number;
  /** Exact Claude count from count_tokens (--exact). */
  exactTokens?: number;
}

export type ProbeStatus = "ok" | "auth" | "timeout" | "error";

export interface ProbeResult {
  status: ProbeStatus;
  ok: boolean;
  error?: string;
  serverName?: string;
  serverVersion?: string;
  instructions?: string;
  tools: ToolInfo[];
  prompts: number;
  resources: number;
  latencyMs: number;
  transportUsed?: ServerConfig["transport"];
}

export type Severity = "error" | "warn" | "info";

export interface Finding {
  id: string;
  severity: Severity;
  server?: string;
  client?: ClientId;
  message: string;
  /** Tokens per session that acting on this finding would save. */
  savings?: number;
}

export interface ServerReport {
  config: ServerConfig;
  probe?: ProbeResult;
  /** Tools after client-side filters. */
  tools: ToolInfo[];
  /** Tokens if every tool definition (and instructions, where the client sends them) loads up front. */
  tokens: number;
  /** Tokens this client actually loads at session start. */
  effectiveTokens: number;
  /** Part of `tokens` that is server instructions (Claude Code loads these at session start). */
  instructionTokens?: number;
  /** Another entry with the same name and higher precedence wins; this one is not loaded. */
  shadowedBy?: string;
  usage?: { calls: number; lastUsed?: string };
}

export interface ClientReport {
  client: ClientId;
  servers: ServerReport[];
  tokens: number;
  effectiveTokens: number;
  toolCount: number;
  /** Active servers whose tools could not be counted. */
  unmeasured: number;
  /** Tokenizer family the counts are expressed in. */
  family: "claude" | "openai";
  notes: string[];
}

export interface Report {
  generatedAt: string;
  cwd: string;
  tokenizer: string;
  probed: boolean;
  clients: ClientReport[];
  findings: Finding[];
}
