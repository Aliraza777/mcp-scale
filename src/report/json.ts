import { totalSavings } from "../analyze/index.js";
import { mask } from "../analyze/secrets.js";
import type { Report } from "../types.js";

/** JSON report with env/header values masked so it is safe to share. */
export function renderJson(report: Report): string {
  return JSON.stringify(
    { ...report, savings: totalSavings(report.findings) },
    (key, value) => {
      if ((key === "env" || key === "headers") && value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(String(v))]));
      if (key === "args" && Array.isArray(value))
        return value.map((a) =>
          /^(gh[pousr]_|sk-|xox|AKIA|AIza)/.test(String(a)) ? mask(String(a)) : a,
        );
      if (key === "url" && typeof value === "string")
        return value.replace(/([?&][^=]*(?:key|token|secret)[^=]*=)[^&]+/gi, "$1****");
      if (key === "inputSchema") return undefined;
      if (key === "probe" && value) {
        const { tools: _tools, instructions, ...rest } = value;
        return { ...rest, instructionsLength: instructions?.length };
      }
      return value;
    },
    2,
  );
}
