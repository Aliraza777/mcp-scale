import type { ClientId, ServerConfig } from "../types.js";
import { claudeCode } from "./claude-code.js";
import { defaultEnv, type Env } from "./env.js";
import { claudeDesktop, codex, cursor, gemini, vscode, windsurf } from "./simple.js";

export const CLIENTS: Record<ClientId, { label: string; discover: (env: Env) => ServerConfig[] }> =
  {
    "claude-code": { label: "Claude Code", discover: claudeCode },
    "claude-desktop": { label: "Claude Desktop", discover: claudeDesktop },
    cursor: { label: "Cursor", discover: cursor },
    vscode: { label: "VS Code", discover: vscode },
    windsurf: { label: "Windsurf", discover: windsurf },
    codex: { label: "Codex", discover: codex },
    gemini: { label: "Gemini CLI", discover: gemini },
  };

export interface DiscoverResult {
  servers: ServerConfig[];
  errors: Array<{ client: ClientId; error: string }>;
}

export function discover(env: Env = defaultEnv(), only?: ClientId[]): DiscoverResult {
  const servers: ServerConfig[] = [];
  const errors: DiscoverResult["errors"] = [];
  for (const [id, client] of Object.entries(CLIENTS) as Array<
    [ClientId, (typeof CLIENTS)[ClientId]]
  >) {
    if (only && !only.includes(id)) continue;
    try {
      servers.push(...client.discover(env));
    } catch (e) {
      errors.push({ client: id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { servers, errors };
}

export { defaultEnv, type Env };
