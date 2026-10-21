import { spawnSync } from "node:child_process";

/** Installed Claude Code version from `claude --version`, or undefined if it isn't installed. */
export function detectClaudeVersion(): string | undefined {
  if (process.env.MCP_SCALE_CLAUDE_VERSION) return process.env.MCP_SCALE_CLAUDE_VERSION;
  try {
    const r = spawnSync("claude", ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    return /(\d+\.\d+\.\d+)/.exec(`${r.stdout ?? ""}`)?.[1];
  } catch {
    return undefined;
  }
}
