import { homedir } from "node:os";
import { join } from "node:path";

/** Filesystem roots used to locate configs. Injectable so tests can point at fixtures. */
export interface Env {
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  /** %APPDATA% on Windows, ~/Library/Application Support on macOS, ~/.config on Linux. */
  appData: string;
  /** Claude Code's system-wide managed-mcp.json. */
  managedMcpFile: string;
}

export function managedMcpPath(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-mcp.json";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-mcp.json";
  return "/etc/claude-code/managed-mcp.json";
}

export function defaultEnv(cwd = process.cwd()): Env {
  const home = homedir();
  const platform = process.platform;
  const appData =
    platform === "win32"
      ? (process.env.APPDATA ?? join(home, "AppData", "Roaming"))
      : platform === "darwin"
        ? join(home, "Library", "Application Support")
        : (process.env.XDG_CONFIG_HOME ?? join(home, ".config"));
  return { home, cwd, platform, appData, managedMcpFile: managedMcpPath(platform) };
}
