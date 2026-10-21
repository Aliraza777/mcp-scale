import type { Finding, ServerConfig } from "../types.js";

const PATTERNS: Array<[string, RegExp]> = [
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI key", /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["AWS access key", /\b(AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{35}\b/],
  ["Stripe key", /\b[rs]k_live_[A-Za-z0-9]{20,}/],
  ["Notion token", /\b(secret_|ntn_)[A-Za-z0-9]{40,}/],
  ["Bearer token", /^Bearer\s+[A-Za-z0-9._~+/-]{20,}=*$/],
];

const SECRET_KEY =
  /(token|secret|password|passwd|api[_-]?key|apikey|auth|credential|private[_-]?key|access[_-]?key)/i;
const isReference = (v: string) => /\$\{[^}]+\}|^\$[A-Z_]+$|^<.*>$|^your[-_ ]/i.test(v);

/** Query parameters of a URL, e.g. `?api_key=...`, checked like env vars. */
function urlParams(url: string | undefined): Array<[string, string]> {
  if (!url) return [];
  try {
    const u = new URL(url.replace(/\$\{[^}]+\}/g, "x"));
    const out: Array<[string, string]> = [...u.searchParams].map(([k, v]) => [`url-param ${k}`, v]);
    if (u.password) out.push(["url-param password", u.password]);
    return out;
  } catch {
    return [];
  }
}

export const mask = (v: string) => (v.length <= 8 ? "****" : `${v.slice(0, 4)}…${v.slice(-2)}`);

export function findSecrets(s: ServerConfig): Finding[] {
  const findings: Finding[] = [];
  const candidates: Array<[string, string]> = [
    ...Object.entries(s.env ?? {}).map(([k, v]) => [`env ${k}`, v] as [string, string]),
    ...Object.entries(s.headers ?? {}).map(([k, v]) => [`header ${k}`, v] as [string, string]),
    ...(s.args ?? []).map((v, i) => [`arg ${i}`, v] as [string, string]),
    ...urlParams(s.url),
  ];
  for (const [where, value] of candidates) {
    if (!value || isReference(value)) continue;
    const match = PATTERNS.find(([, re]) => re.test(value));
    const keyName = where.split(" ")[1] ?? "";
    const looksSecret =
      match || (SECRET_KEY.test(keyName) && value.length >= 16 && !/\s/.test(value));
    if (!looksSecret) continue;
    findings.push({
      id: "hardcoded-secret",
      severity: "error",
      server: s.name,
      client: s.client,
      message: `${s.name}: ${match?.[0] ?? "possible secret"} hardcoded in ${where} (${mask(value)}) in ${s.sourceFile}. Reference an environment variable instead.`,
    });
  }
  return findings;
}
