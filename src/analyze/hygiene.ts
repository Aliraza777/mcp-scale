import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { ClientId, Finding, ServerConfig } from "../types.js";

export function onPath(command: string, pathEnv = process.env.PATH ?? ""): boolean {
  const exts =
    process.platform === "win32"
      ? [
          "",
          ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase()),
        ]
      : [""];
  const candidates =
    isAbsolute(command) || command.includes("/") || command.includes("\\")
      ? exts.map((e) => command + e)
      : pathEnv.split(delimiter).flatMap((dir) => exts.map((e) => join(dir, command + e)));
  return candidates.some((c) => {
    try {
      accessSync(c, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return statSync(c).isFile();
    } catch {
      return false;
    }
  });
}

const RUNNERS = new Set(["npx", "bunx", "pnpx", "uvx", "pipx"]);

/** Package spec of `npx -y pkg@x`, `uvx --from pkg@x cmd`, `pnpm dlx pkg`. */
export function runnerPackage(command: string, args: string[]): string | undefined {
  const base = (command.split(/[\\/]/).pop() ?? command).replace(/\.(cmd|exe)$/i, "");
  let rest = args;
  if ((base === "pnpm" || base === "yarn") && args[0] === "dlx") rest = args.slice(1);
  else if (!RUNNERS.has(base)) return undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a === "--from" || a === "--package" || a === "-p") return rest[i + 1];
    if (a.startsWith("--package=") || a.startsWith("--from=")) return a.split("=")[1];
    if (!a.startsWith("-")) return a;
  }
  return undefined;
}

/** npm `pkg@1.2.3`, `@scope/pkg@1`; PyPI `pkg==1.2` or `pkg@1.2`. */
export function isPinned(spec: string): boolean {
  if (/==/.test(spec)) return true;
  const at = spec.lastIndexOf("@");
  if (at <= 0) return false;
  const version = spec.slice(at + 1);
  return version !== "" && version !== "latest" && version !== "next";
}

export function hygiene(s: ServerConfig, checkPath = true): Finding[] {
  if (s.disabled || s.transport !== "stdio" || !s.command) return [];
  if (checkPath && !s.command.includes("${") && !onPath(s.command))
    return [
      {
        id: "command-not-found",
        severity: "error",
        server: s.name,
        client: s.client,
        message: `${s.name}: command "${s.command}" is not on PATH, so this server cannot start.`,
      },
    ];
  return [];
}

/** One finding per client listing every unpinned runner package. */
export function unpinnedSummary(client: ClientId, servers: ServerConfig[]): Finding[] {
  const unpinned = servers.filter((s) => {
    if (s.transport !== "stdio" || !s.command) return false;
    const pkg = runnerPackage(s.command, s.args ?? []);
    return pkg !== undefined && !isPinned(pkg);
  });
  if (!unpinned.length) return [];
  return [
    {
      id: "unpinned-package",
      severity: "info",
      client,
      message: `${unpinned.length} server(s) run an unpinned package (${unpinned.map((s) => s.name).join(", ")}): tool definitions can change silently on any restart. Pin versions, e.g. pkg@1.2.3.`,
    },
  ];
}
