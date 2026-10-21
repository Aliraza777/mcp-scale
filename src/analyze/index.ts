import type { Env } from "../clients/env.js";
import {
  defersTools,
  type LoadModel,
  type LoadOptions,
  loadModel,
  serverLoad,
  toolTokens,
} from "../clients-behavior.js";
import { configKey } from "../probe.js";
import type {
  ClientId,
  ClientReport,
  Finding,
  ProbeResult,
  Report,
  ServerConfig,
  ServerReport,
  ToolInfo,
} from "../types.js";
import { claudeCodeCompat, openAiCompat } from "./compat.js";
import { hygiene, unpinnedSummary } from "./hygiene.js";
import { findSecrets } from "./secrets.js";
import { normalizeServerName, type ToolUsage } from "./usage.js";

export const THRESHOLDS = {
  heavyServerTokens: 5_000,
  heavyServerShare: 0.4,
  bloatedToolTokens: 1_000,
  manyTools: 40,
  unusedDays: 30,
};

const SCOPE_PRECEDENCE: Record<ServerConfig["scope"], number> = {
  managed: 0,
  local: 1,
  project: 2,
  user: 3,
  extension: 4,
};

export interface AnalyzeInput {
  env: Env;
  servers: ServerConfig[];
  probes?: Map<string, ProbeResult>;
  usage?: Map<string, ToolUsage>;
  tokenizer: string;
  checkPath?: boolean;
  procEnv?: NodeJS.ProcessEnv;
  loadOptions?: LoadOptions;
}

export function applyToolFilter(tools: ToolInfo[], s: ServerConfig): ToolInfo[] {
  const f = s.toolFilter;
  if (!f) return tools;
  return tools.filter(
    (t) => (!f.include || f.include.includes(t.name)) && !f.exclude?.includes(t.name),
  );
}

export function analyze(input: AnalyzeInput): Report {
  const { env, servers, probes, usage } = input;
  const findings: Finding[] = [];
  const clients: ClientReport[] = [];
  const byClient = new Map<ClientId, ServerConfig[]>();
  for (const s of servers) byClient.set(s.client, [...(byClient.get(s.client) ?? []), s]);
  const compatChecked = new Set<string>();

  for (const [client, configs] of byClient) {
    const model = loadModel(client, env, input.procEnv, input.loadOptions);
    // Same name in several scopes: only the highest-precedence entry loads.
    const winner = new Map<string, ServerConfig>();
    for (const s of [...configs]
      .filter((c) => !c.disabled && !c.pendingApproval)
      .sort((a, b) => SCOPE_PRECEDENCE[a.scope] - SCOPE_PRECEDENCE[b.scope]))
      if (!winner.has(s.name)) winner.set(s.name, s);

    const reports: ServerReport[] = configs.map((config) => {
      const probe = config.disabled ? undefined : probes?.get(configKey(config));
      const tools = applyToolFilter(probe?.tools ?? [], config);
      const w = winner.get(config.name);
      return {
        config,
        probe,
        tools,
        tokens: 0,
        effectiveTokens: 0,
        shadowedBy:
          !config.disabled && !config.pendingApproval && w && w !== config
            ? `${w.scope} scope`
            : undefined,
      };
    });
    const active = reports.filter(
      (r) => !r.config.disabled && !r.shadowedBy && !r.config.pendingApproval,
    );
    const pending = reports.filter((r) => r.config.pendingApproval && !r.config.disabled);
    const loads = new Map(
      [...active, ...pending].map((r) => [
        r,
        serverLoad(r.tools, r.config, r.probe?.instructions, model),
      ]),
    );
    const defer = defersTools(
      model,
      active.reduce((n, r) => n + (loads.get(r)?.deferrableFull ?? 0), 0),
    );
    for (const [r, load] of loads) {
      r.tokens = load.full;
      r.instructionTokens = load.instructions || undefined;
      r.effectiveTokens = defer ? load.deferred : load.full;
      if (client === "claude-code" && usage) {
        const u = usage.get(normalizeServerName(r.config.name));
        r.usage = { calls: u?.calls ?? 0, lastUsed: u?.lastUsed };
      }
    }

    for (const r of reports)
      findings.push(...findSecrets(r.config), ...hygiene(r.config, input.checkPath ?? true));
    findings.push(
      ...unpinnedSummary(
        client,
        configs.filter((c) => !c.disabled),
      ),
    );
    for (const r of active) {
      findings.push(...probeFindings(r));
      if (!r.probe?.ok) continue;
      if (client === "claude-code")
        findings.push(
          ...claudeCodeCompat(r.config.name, r.tools, r.probe.instructions, model, defer),
        );
      const key = configKey(r.config);
      if (!compatChecked.has(key) && client !== "claude-code" && client !== "claude-desktop") {
        compatChecked.add(key);
        findings.push(...openAiCompat(r.config.name, client, r.tools));
      }
    }

    const notes = model.note ? [model.note] : [];
    const effective = active.reduce((n, r) => n + r.effectiveTokens, 0);
    const toolCount = active.reduce((n, r) => n + r.tools.length, 0);
    findings.push(...clientFindings(client, active, effective, toolCount, defer, model));
    findings.push(...duplicateFindings(client, reports));
    if (pending.length)
      findings.push({
        id: "pending-approval",
        severity: "info",
        client,
        message: `${pending.length} .mcp.json server(s) await approval in Claude Code (${pending.map((r) => r.config.name).join(", ")}) and are not counted; approving them adds ${fmt(pending.reduce((n, r) => n + r.effectiveTokens, 0))} tokens. \`claude -p\` loads them without asking.`,
      });
    clients.push({
      client,
      servers: reports.sort(
        (a, b) => inactiveRank(a) - inactiveRank(b) || b.effectiveTokens - a.effectiveTokens,
      ),
      tokens: active.reduce((n, r) => n + r.tokens, 0),
      effectiveTokens: effective,
      toolCount,
      unmeasured: probes ? active.filter((r) => !r.probe?.ok).length : active.length,
      family: model.family,
      notes,
    });
  }

  clients.sort((a, b) => b.effectiveTokens - a.effectiveTokens);
  const order = { error: 0, warn: 1, info: 2 };
  findings.sort(
    (a, b) => order[a.severity] - order[b.severity] || (b.savings ?? 0) - (a.savings ?? 0),
  );
  return {
    generatedAt: new Date().toISOString(),
    cwd: env.cwd,
    tokenizer: input.tokenizer,
    probed: !!probes,
    clients,
    findings,
  };
}

const inactiveRank = (r: ServerReport) =>
  r.config.disabled ? 3 : r.shadowedBy ? 2 : r.config.pendingApproval ? 1 : 0;

function probeFindings(r: ServerReport): Finding[] {
  const p = r.probe;
  if (!p || p.ok) return [];
  const base = { server: r.config.name, client: r.config.client };
  if (p.status === "auth")
    return [
      {
        ...base,
        id: "needs-auth",
        severity: "info",
        message: `${r.config.name}: needs sign-in (${p.error}). Its tools were not counted; mcp-scale can't use the client's OAuth session.`,
      },
    ];
  if (p.status === "timeout")
    return [
      {
        ...base,
        id: "probe-timeout",
        severity: "warn",
        message: `${r.config.name}: did not respond (${p.error}). Try --timeout 60000 if it downloads on first start.`,
      },
    ];
  return [
    {
      ...base,
      id: "probe-failed",
      severity: "error",
      message: `${r.config.name}: failed to start — ${p.error}`,
    },
  ];
}

/** Per server, the biggest saving among its findings (avoids double counting heavy + unused). */
export function totalSavings(findings: Finding[]): number {
  const best = new Map<string, number>();
  for (const f of findings) {
    if (!f.savings) continue;
    const key = `${f.client}/${f.server}`;
    best.set(key, Math.max(best.get(key) ?? 0, f.savings));
  }
  return [...best.values()].reduce((a, b) => a + b, 0);
}

const fmt = (n: number) => n.toLocaleString("en-US");

function clientFindings(
  client: ClientId,
  active: ServerReport[],
  effective: number,
  toolCount: number,
  deferred: boolean,
  model: LoadModel,
): Finding[] {
  const out: Finding[] = [];
  for (const r of active) {
    const name = r.config.name;
    const share = r.effectiveTokens / Math.max(effective, 1);
    if (
      r.effectiveTokens >= THRESHOLDS.heavyServerTokens &&
      (active.length === 1 || share >= THRESHOLDS.heavyServerShare)
    )
      out.push({
        id: "heavy-server",
        severity: "warn",
        server: name,
        client,
        message: `${name}: loads ${fmt(r.effectiveTokens)} tokens at session start (${Math.round(share * 100)}% of this client's MCP cost). Enable it only in projects that need it.`,
        savings: r.effectiveTokens,
      });
    const bloated = r.tools
      .map((t) => ({ name: t.name, tokens: toolTokens(t, name, model) }))
      .filter((t) => t.tokens >= THRESHOLDS.bloatedToolTokens);
    if (bloated.length)
      out.push({
        id: "bloated-tool",
        severity: "info",
        server: name,
        client,
        message: `${name}: ${bloated.map((t) => `${t.name} (${fmt(t.tokens)} tok)`).join(", ")} ${bloated.length === 1 ? "is an" : "are"} unusually large tool definition${bloated.length === 1 ? "" : "s"}.`,
      });
    if (r.usage && r.usage.calls === 0 && r.probe?.ok && r.effectiveTokens > 0)
      out.push({
        id: "unused-server",
        severity: "warn",
        server: name,
        client,
        message: `${name}: not called in Claude Code in the last ${THRESHOLDS.unusedDays} days; it still costs ${fmt(r.effectiveTokens)} tokens per session.`,
        savings: r.effectiveTokens,
      });
  }
  if (toolCount > THRESHOLDS.manyTools && !deferred)
    out.push({
      id: "many-tools",
      severity: "warn",
      client,
      message: `${toolCount} MCP tools load into every request. Long tool lists cost context and make the model worse at choosing tools${model.prefixNames ? "; consider leaving Tool Search on" : ""}.`,
    });
  return out;
}

/** The same server under different names in one client loads twice. */
function duplicateFindings(client: ClientId, reports: ServerReport[]): Finding[] {
  const groups = new Map<string, ServerReport[]>();
  for (const r of reports)
    if (!r.config.disabled && !r.shadowedBy)
      groups.set(configKey(r.config), [...(groups.get(configKey(r.config)) ?? []), r]);
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({
      id: "duplicate-server",
      severity: "warn" as const,
      client,
      server: g[1]?.config.name,
      message: `Same server configured ${g.length}× under different names (${g.map((r) => `${r.config.name} [${r.config.scope}]`).join(", ")}); its tools load once per entry.`,
      savings: g.slice(1).reduce((n, r) => n + r.effectiveTokens, 0) || undefined,
    }));
}
