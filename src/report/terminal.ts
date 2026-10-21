import pc from "picocolors";
import { totalSavings } from "../analyze/index.js";
import { CLIENTS } from "../clients/index.js";
import type { ClientReport, Finding, Report, ServerReport } from "../types.js";

const BAR_WIDTH = 20;
export const fmt = (n: number) => n.toLocaleString("en-US");
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function bar(value: number, max: number): string {
  const filled = max > 0 ? Math.max(value > 0 ? 1 : 0, Math.round((value / max) * BAR_WIDTH)) : 0;
  return pc.cyan("█".repeat(filled)) + pc.dim("·".repeat(BAR_WIDTH - filled));
}

function status(r: ServerReport): string | undefined {
  if (r.config.disabled) return pc.dim(`off — ${r.config.disabledReason ?? "disabled"}`);
  if (r.shadowedBy) return pc.dim(`overridden by the ${r.shadowedBy} entry`);
  if (r.config.pendingApproval)
    return pc.dim(
      r.probe?.ok
        ? `awaiting approval in Claude Code — ${fmt(r.effectiveTokens)} tok once approved`
        : "awaiting approval in Claude Code",
    );
  if (!r.probe) return pc.dim("not measured");
  if (r.probe.status === "auth") return pc.yellow("needs sign-in — not counted");
  if (r.probe.status === "timeout") return pc.yellow("no response — not counted");
  if (!r.probe.ok) return pc.red(`failed — ${truncate(r.probe.error ?? "", 70)}`);
  return undefined;
}

function serverLine(r: ServerReport, max: number, nameWidth: number, deferred: boolean): string {
  const name = truncate(r.config.name, nameWidth).padEnd(nameWidth);
  const scope = pc.dim(r.config.scope.padEnd(9));
  const s = status(r);
  if (s)
    return `  ${s.includes("off —") || s.includes("overridden") ? pc.dim(name) : name} ${scope} ${s}`;
  const tools = `${r.tools.length} tool${r.tools.length === 1 ? " " : "s"}`.padStart(9);
  const tok = fmt(deferred ? r.effectiveTokens : r.tokens).padStart(7);
  const extra = deferred ? pc.dim(` (${fmt(r.tokens)} if loaded)`) : "";
  const usage = r.usage
    ? pc.dim(r.usage.calls ? `  ${fmt(r.usage.calls)} calls/30d` : "  unused 30d")
    : "";
  return `  ${name} ${scope} ${tools} ${tok} tok  ${bar(deferred ? r.effectiveTokens : r.tokens, max)}${extra}${usage}`;
}

const ICON: Record<Finding["severity"], string> = {
  error: pc.red("✖"),
  warn: pc.yellow("⚠"),
  info: pc.blue("ℹ"),
};

function headline(c: ClientReport, probed: boolean): string {
  if (!probed) return pc.dim("configs only");
  const deferred = c.effectiveTokens < c.tokens;
  const plus = c.unmeasured
    ? pc.yellow(` + ${c.unmeasured} server${c.unmeasured === 1 ? "" : "s"} not counted`)
    : "";
  if (deferred)
    return `${pc.bold(fmt(c.effectiveTokens))} tokens at session start ${pc.dim(`(${fmt(c.tokens)} if every tool loaded)`)}${plus}`;
  return `${pc.bold(fmt(c.effectiveTokens))} tokens in every request${plus}`;
}

export function renderTerminal(report: Report): string {
  const lines: string[] = [""];
  const total = report.clients.reduce((n, c) => n + c.servers.length, 0);
  lines.push(
    `${pc.bold("mcp-scale")} ${pc.dim(`· ${total} MCP server entr${total === 1 ? "y" : "ies"} in ${report.clients.length} client${report.clients.length === 1 ? "" : "s"} · tokens ${report.tokenizer}`)}`,
  );
  if (total === 0) {
    lines.push(
      "",
      "  No MCP servers found. Looked in Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Codex and Gemini CLI configs.",
      pc.dim(
        "  Claude Code plugin servers and claude.ai connectors are not read; see /context in Claude Code.",
      ),
      "",
    );
    return lines.join("\n");
  }
  const counted = (r: ServerReport, deferred: boolean) => (deferred ? r.effectiveTokens : r.tokens);
  const max = Math.max(
    1,
    ...report.clients.flatMap((c) =>
      c.servers.map((s) => counted(s, c.effectiveTokens < c.tokens)),
    ),
  );
  const nameWidth = Math.min(
    22,
    Math.max(4, ...report.clients.flatMap((c) => c.servers.map((s) => s.config.name.length))),
  );

  for (const c of report.clients) {
    const deferred = c.effectiveTokens < c.tokens;
    const family = report.probed
      ? pc.dim(c.family === "claude" ? " · Claude tokens" : " · GPT tokens")
      : "";
    lines.push(
      "",
      `${pc.bold(CLIENTS[c.client].label)}  ${pc.dim(`${c.toolCount} tools ·`)} ${headline(c, report.probed)}${family}`,
    );
    for (const n of c.notes) lines.push(`  ${pc.dim(n)}`);
    for (const s of c.servers) lines.push(serverLine(s, max, nameWidth, deferred));
  }

  if (report.findings.length) {
    lines.push("", pc.bold("Findings"));
    for (const f of report.findings) {
      const where =
        f.client && report.clients.length > 1 ? pc.dim(` [${CLIENTS[f.client].label}]`) : "";
      lines.push(`  ${ICON[f.severity]} ${f.message}${where}`);
    }
  }

  const savings = totalSavings(report.findings);
  if (savings > 0)
    lines.push(
      "",
      `${pc.green("→")} Acting on these findings saves about ${pc.bold(fmt(savings))} tokens per session. Scope servers per project with ${pc.cyan("mcp-scale profile")}.`,
    );
  if (!report.probed)
    lines.push(
      "",
      pc.dim("Configs only. Run without --static to connect to servers and count tokens."),
    );
  else if (!report.tokenizer.startsWith("exact"))
    lines.push(
      "",
      pc.dim(
        "Estimates: GPT counts use o200k; Claude counts are calibrated to Claude Code's /context (±6% per tool). --exact asks Anthropic's count_tokens instead.",
      ),
    );
  lines.push("");
  return lines.join("\n");
}
