import { createInterface } from "node:readline/promises";
import Anthropic from "@anthropic-ai/sdk";
import pc from "picocolors";
import { analyze } from "./analyze/index.js";
import { claudeCodeUsage } from "./analyze/usage.js";
import { detectClaudeVersion } from "./claude-version.js";
import { discover, type Env } from "./clients/index.js";
import type { TokenFamily } from "./clients-behavior.js";
import { configKey, probeAll } from "./probe.js";
import { anthropicCounter, type CountTokens, EXACT_MODEL, exactServerTokens } from "./tokens.js";
import type { ClientId, ProbeResult, Report, ServerConfig } from "./types.js";

export interface ScanOptions {
  static?: boolean;
  yes?: boolean;
  clients?: ClientId[];
  exact?: boolean;
  timeout?: number;
  quiet?: boolean;
  filter?: (s: ServerConfig) => boolean;
  /** Count Claude Code .mcp.json servers as approved (CI: what is committed is what loads with `claude -p`). */
  assumeApproved?: boolean;
  /** Tokenizer family for all clients; "auto" picks per client. */
  tokenizer?: TokenFamily | "auto";
  /** Injected for tests. */
  counter?: CountTokens;
}

const describe = (s: ServerConfig) =>
  s.transport === "stdio"
    ? [s.command, ...(s.args ?? [])].join(" ")
    : `${s.transport.toUpperCase()} ${s.url}`;

/** Probing runs the configured commands, so show them and ask first. */
async function confirmProbe(servers: ServerConfig[]): Promise<boolean> {
  const unique = new Map(servers.map((s) => [configKey(s), s]));
  process.stderr.write(
    `\nmcp-scale will start or connect to ${unique.size} MCP server(s) to read their tool lists:\n`,
  );
  for (const s of unique.values())
    process.stderr.write(`  ${pc.bold(s.name)}  ${pc.dim(describe(s))}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question("\nContinue? [y/N] ");
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** Attach exact Claude counts, scaling per-tool estimates to each server's exact total. */
export async function applyExactCounts(probes: Map<string, ProbeResult>, count: CountTokens) {
  const measured = [...probes.values()].filter((p) => p.ok && p.tools.length);
  const { perServer } = await exactServerTokens(
    count,
    measured.map((p) => p.tools),
  );
  measured.forEach((probe, i) => {
    const exact = perServer[i] ?? 0;
    const estimate = probe.tools.reduce((n, t) => n + t.tokens, 0) || 1;
    let assigned = 0;
    probe.tools.forEach((t, j) => {
      t.exactTokens =
        j === probe.tools.length - 1
          ? Math.max(0, exact - assigned)
          : Math.round((t.tokens / estimate) * exact);
      assigned += t.exactTokens;
    });
  });
}

export async function scan(env: Env, opts: ScanOptions = {}): Promise<Report> {
  const log = (m: string) => {
    if (!opts.quiet) process.stderr.write(`${m}\n`);
  };
  const { servers: all, errors } = discover(env, opts.clients);
  for (const e of errors) log(pc.yellow(`⚠ Could not read ${e.client} config: ${e.error}`));
  const servers = opts.filter ? all.filter(opts.filter) : all;
  if (opts.assumeApproved) for (const s of servers) s.pendingApproval = false;
  const active = servers.filter((s) => !s.disabled && !s.unsupported);

  let doProbe = !opts.static && active.length > 0;
  let skipReason: Report["skipReason"] = opts.static ? "static" : undefined;
  if (doProbe && !opts.yes) {
    if (process.stdin.isTTY) {
      doProbe = await confirmProbe(active);
      if (!doProbe) skipReason = "declined";
    } else {
      log(pc.yellow("Not a TTY, so running a static scan. Pass --yes to connect to servers."));
      doProbe = false;
      skipReason = "no-tty";
    }
  }

  let probes: Map<string, ProbeResult> | undefined;
  let tokenizer = "≈ estimate";
  if (doProbe) {
    const n = new Set(active.map(configKey)).size;
    log(pc.dim(`Connecting to ${n} server(s)…`));
    probes = await probeAll(
      servers.filter((s) => !s.disabled),
      {
        timeoutMs: opts.timeout,
        ctx: { env: process.env, home: env.home, cwd: env.cwd },
        onDone: (s, r) => {
          const icon = r.ok ? pc.green("✓") : r.status === "auth" ? pc.yellow("🔒") : pc.red("✖");
          log(pc.dim(`  ${icon} ${s.name} (${(r.latencyMs / 1000).toFixed(1)}s)`));
        },
      },
    );
    if (opts.exact) {
      try {
        await applyExactCounts(probes, opts.counter ?? anthropicCounter(new Anthropic()));
        tokenizer = `exact for Claude clients (${EXACT_MODEL} count_tokens)`;
      } catch (e) {
        log(
          pc.yellow(
            `⚠ Exact counting failed, using estimates: ${e instanceof Error ? e.message.split("\n")[0] : e}`,
          ),
        );
      }
    }
  }

  const hasClaudeCode = servers.some((s) => s.client === "claude-code");
  const usage = hasClaudeCode ? await claudeCodeUsage(env.home).catch(() => undefined) : undefined;
  const claudeVersion = hasClaudeCode ? detectClaudeVersion() : undefined;
  const report = analyze({
    env,
    servers,
    probes,
    usage,
    tokenizer,
    loadOptions: { family: opts.tokenizer ?? "auto", claudeVersion },
  });
  if (!report.probed) report.skipReason = skipReason;
  return report;
}
