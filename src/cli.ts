import { Command, Option } from "commander";
import pc from "picocolors";
import { CLIENTS, defaultEnv, discover } from "./clients/index.js";
import { probe } from "./probe.js";
import {
  applyProfile,
  listProfiles,
  loadProfile,
  PROFILE_CLIENTS,
  restore,
  saveProfile,
} from "./profile.js";
import { renderJson } from "./report/json.js";
import { renderMarkdown } from "./report/markdown.js";
import { renderTerminal } from "./report/terminal.js";
import { scan } from "./scan.js";
import { estimateTokens } from "./tokens.js";
import type { ClientId } from "./types.js";
import { VERSION } from "./version.js";

const clientIds = Object.keys(CLIENTS) as ClientId[];
const clientOption = () =>
  new Option("-c, --client <clients...>", "only these clients").choices(clientIds);
const timeoutOption = () =>
  new Option("--timeout <ms>", "per-server connect timeout")
    .argParser((v) => {
      const n = Number.parseInt(v, 10);
      if (!(n > 0)) throw new Error("--timeout must be a positive number of milliseconds");
      return n;
    })
    .default(30_000);

const tokenizerOption = () =>
  new Option(
    "-t, --tokenizer <family>",
    "count as Claude or GPT tokens (auto: Claude for Claude Code/Desktop, GPT for other clients)",
  )
    .choices(["auto", "claude", "openai"])
    .default("auto");

const program = new Command()
  .name("mcp-scale")
  .description(
    "Weigh your MCP setup: how many context tokens each MCP server costs, in every client.",
  )
  .version(VERSION);

program
  .command("scan", { isDefault: true })
  .description("find MCP servers in all clients, count their tool-definition tokens, report waste")
  .option("-s, --static", "only read configs; do not start or connect to servers")
  .option("-y, --yes", "connect to servers without asking")
  .addOption(clientOption())
  .option(
    "--exact",
    "exact Claude counts via Anthropic count_tokens (sends tool definitions to Anthropic)",
  )
  .addOption(timeoutOption())
  .addOption(
    new Option("-f, --format <format>", "output format")
      .choices(["text", "json", "md"])
      .default("text"),
  )
  .addOption(tokenizerOption())
  .option("--strict", "exit with code 1 when any error-level finding is reported")
  .action(async (opts) => {
    const report = await scan(defaultEnv(), {
      tokenizer: opts.tokenizer,
      static: opts.static,
      yes: opts.yes,
      clients: opts.client,
      exact: opts.exact,
      timeout: opts.timeout,
      quiet: opts.format !== "text",
    });
    const out =
      opts.format === "json"
        ? renderJson(report)
        : opts.format === "md"
          ? renderMarkdown(report)
          : renderTerminal(report);
    process.stdout.write(`${out}\n`);
    if (opts.strict && report.findings.some((f) => f.severity === "error")) process.exitCode = 1;
  });

program
  .command("tools <server>")
  .description("list one server's tools, heaviest first")
  .addOption(clientOption())
  .addOption(timeoutOption())
  .action(async (name: string, opts) => {
    const env = defaultEnv();
    const matches = discover(env, opts.client).servers.filter((s) => s.name === name);
    const config = matches.find((s) => !s.disabled) ?? matches[0];
    if (!config) {
      const names = [...new Set(discover(env).servers.map((s) => s.name))];
      throw new Error(
        `No server named "${name}".${names.length ? ` Known servers: ${names.join(", ")}` : ""}`,
      );
    }
    const r = await probe(config, {
      timeoutMs: opts.timeout,
      ctx: { env: process.env, home: env.home, cwd: env.cwd },
    });
    if (!r.ok) throw new Error(`Could not connect to ${name}: ${r.error}`);
    const total = r.tools.reduce((n, t) => n + t.tokens, 0);
    const inst = r.instructions ? estimateTokens(r.instructions) : 0;
    console.log(
      `\n${pc.bold(name)} ${pc.dim(`${r.serverName ?? ""} ${r.serverVersion ?? ""} · ${CLIENTS[config.client].label} · ${r.transportUsed}`)}`,
    );
    console.log(
      `${r.tools.length} tools · ${total.toLocaleString("en-US")} tokens of tool definitions${inst ? ` · ${inst.toLocaleString("en-US")} tokens of server instructions` : ""} ${pc.dim("(≈ o200k)")}\n`,
    );
    const width = Math.min(40, Math.max(...r.tools.map((t) => t.name.length), 4));
    for (const t of [...r.tools].sort((a, b) => b.tokens - a.tokens)) {
      const desc = (t.description ?? "").replace(/\s+/g, " ").trim();
      console.log(
        `  ${t.tokens.toLocaleString("en-US").padStart(6)}  ${t.name.padEnd(width)}  ${pc.dim(`${desc.slice(0, 60)}${desc.length > 60 ? "…" : ""}`)}`,
      );
    }
    if (r.prompts || r.resources)
      console.log(
        pc.dim(`\n  Also exposes ${r.prompts} prompt(s) and ${r.resources} resource(s).`),
      );
    console.log("");
  });

const profile = program
  .command("profile")
  .description("save and apply per-project sets of MCP servers");

profile
  .command("create <name>")
  .description("save a named set of servers")
  .requiredOption("-k, --keep <servers>", "comma-separated server names to keep")
  .action((name: string, opts) => {
    const keep = opts.keep
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
    if (!keep.length) throw new Error("--keep needs at least one server name");
    const known = new Set(discover(defaultEnv()).servers.map((s) => s.name));
    const unknown = keep.filter((k: string) => !known.has(k));
    const file = saveProfile(defaultEnv(), { name, keep });
    console.log(`${pc.green("✓")} Saved profile ${pc.bold(name)} → ${file}`);
    if (unknown.length)
      console.log(pc.yellow(`⚠ Not found in any config right now: ${unknown.join(", ")}`));
  });

profile
  .command("list")
  .description("list saved profiles")
  .action(() => {
    const profiles = listProfiles(defaultEnv());
    if (!profiles.length)
      console.log("No profiles yet. Create one: mcp-scale profile create <name> --keep a,b");
    for (const p of profiles) console.log(`${pc.bold(p.name)}  ${p.keep.join(", ")}`);
  });

profile
  .command("apply <name>")
  .description("write the profile's servers to this project's config for a client")
  .addOption(
    new Option("-c, --client <client>", "target client")
      .choices(PROFILE_CLIENTS)
      .default("claude-code"),
  )
  .option(
    "--prune-user",
    "also remove servers outside the profile from the client's user-level config",
  )
  .action((name: string, opts) => {
    const env = defaultEnv();
    const res = applyProfile(env, loadProfile(env, name), opts.client, discover(env).servers, {
      pruneUser: opts.pruneUser,
    });
    console.log(`${pc.green("✓")} Wrote ${res.kept.length} server(s) to ${res.written}`);
    if (res.missing.length)
      console.log(pc.yellow(`⚠ Not found in any client config: ${res.missing.join(", ")}`));
    if (res.pruned.length)
      console.log(`${pc.green("✓")} Removed from user config: ${res.pruned.join(", ")}`);
    if (res.stillLoaded.length)
      console.log(
        pc.yellow(
          `⚠ Still loaded in every project from the user-level config: ${res.stillLoaded.join(", ")}. Re-run with --prune-user to remove them there.`,
        ),
      );
    if (opts.client === "claude-code")
      console.log(
        pc.dim(
          "Claude Code asks you to approve .mcp.json servers the first time it starts in this project.",
        ),
      );
    if (res.pruned.length)
      console.log(
        pc.dim(
          "Restart the client so it re-reads its config (Claude Code rewrites ~/.claude.json while running).",
        ),
      );
    console.log(pc.dim(`Backup: ${res.backupDir}  (undo with: mcp-scale restore)`));
  });

program
  .command("restore")
  .description("undo the last profile apply")
  .action(() => {
    const { files } = restore(defaultEnv());
    console.log(`${pc.green("✓")} Restored ${files.join(", ")}`);
  });

program
  .command("ci")
  .description("fail when the project's committed MCP configs exceed a token budget")
  .requiredOption("--max-tokens <n>", "budget per client", (v) => {
    const n = Number.parseInt(v, 10);
    if (!(n >= 0)) throw new Error("--max-tokens must be a non-negative number");
    return n;
  })
  .addOption(clientOption())
  .addOption(timeoutOption())
  .option("--allow-unmeasured", "do not fail when a server can't be measured")
  .addOption(tokenizerOption())
  .action(async (opts) => {
    const report = await scan(defaultEnv(), {
      tokenizer: opts.tokenizer,
      yes: true,
      clients: opts.client,
      timeout: opts.timeout,
      filter: (s) => s.scope === "project",
      assumeApproved: true,
    });
    process.stdout.write(`${renderTerminal(report)}\n`);
    let failed = false;
    for (const c of report.clients) {
      if (c.effectiveTokens > opts.maxTokens) {
        failed = true;
        console.error(
          pc.red(
            `✖ ${CLIENTS[c.client].label}: ${c.effectiveTokens.toLocaleString("en-US")} tokens > budget ${opts.maxTokens.toLocaleString("en-US")}`,
          ),
        );
      }
      if (c.unmeasured && !opts.allowUnmeasured) {
        failed = true;
        console.error(
          pc.red(
            `✖ ${CLIENTS[c.client].label}: ${c.unmeasured} server(s) could not be measured (pass --allow-unmeasured to ignore)`,
          ),
        );
      }
    }
    if (report.findings.some((f) => f.id === "hardcoded-secret")) {
      failed = true;
      console.error(pc.red("✖ Hardcoded secret in a committed MCP config"));
    }
    if (!report.clients.length) console.log("No project-scoped MCP configs found.");
    if (failed) process.exitCode = 1;
  });

program.parseAsync().catch((e: unknown) => {
  console.error(pc.red(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
