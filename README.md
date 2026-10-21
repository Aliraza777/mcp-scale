# mcp-scale

[![CI](https://github.com/Aliraza777/mcp-scale/actions/workflows/ci.yml/badge.svg)](https://github.com/Aliraza777/mcp-scale/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Weigh your MCP setup.** See how many context-window tokens each MCP server costs you before you type a single word, in every AI coding client on your machine.

```
$ npx mcp-scale --yes

mcp-scale · 10 MCP server entries in 1 client · tokens ≈ estimate

Cursor  81 tools · 18,725 tokens in every request + 2 servers not counted · GPT tokens
  brave               user        8 tools   8,282 tok  ████████████████████
  playwright          user       25 tools   3,745 tok  █████████···········
  everything          user       19 tools   1,892 tok  █████···············
  filesystem          user       14 tools   1,678 tok  ████················
  context7            user        2 tools   1,060 tok  ███·················
  memory              user        9 tools     965 tok  ██··················
  sequential-thinking user        1 tool      864 tok  ██··················
  deepwiki            user        3 tools     239 tok  █···················
  github-remote       user      needs sign-in — not counted
  linear              user      needs sign-in — not counted

Findings
  ✖ brave: possible secret hardcoded in env BRAVE_API_KEY (BSAq…f2) in ~/.cursor/mcp.json. Reference an environment variable instead.
  ⚠ brave: loads 8,282 tokens at session start (44% of this client's MCP cost). Enable it only in projects that need it.
  ⚠ 81 MCP tools load into every request. Long tool lists cost context and make the model worse at choosing tools.
  ℹ 7 server(s) run an unpinned package (filesystem, memory, everything, …): tool definitions can change silently on any restart.
  ℹ linear: needs sign-in (HTTP 401). Its tools were not counted; mcp-scale can't use the client's OAuth session.
  ℹ brave: brave_web_search (1,367 tok), brave_local_search (1,386 tok), … are unusually large tool definitions.

→ Acting on these findings saves about 8,282 tokens per session.
```

<sub>Real output from popular servers, October 2026 (the Brave key is a dummy). Run it to see your own numbers.</sub>

## Why

Every MCP server you connect sends its tool list (names, descriptions and JSON schemas) to the model. In most clients that happens in every request. A few popular servers can use **tens of thousands of tokens** before you start, which costs money and context and makes the model worse at picking tools. Most clients never show you this number.

`mcp-scale` finds every MCP config on your machine, connects to each server, counts the tokens, and tells you what to trim.

## Features

- **Finds every config automatically:** Claude Code (user, local, `.mcp.json`, managed `managed-mcp.json`), Claude Desktop (config and installed extensions), Cursor, VS Code (and Insiders), Windsurf, Codex and Gemini CLI.
- **Follows each client's real rules:**
  - Claude Code scope precedence (local > project > user), `.mcp.json` approval and folder trust, `disabledMcpjsonServers`, `deniedMcpServers`, and managed-config exclusive control.
  - Tool Search: `ENABLE_TOOL_SEARCH` (`true`/`false`/`auto`/`auto:N`), `alwaysLoad` per server or per tool, and description truncation. Version-specific rules apply to the Claude Code you have installed.
  - Gemini `includeTools`/`excludeTools` and Codex `enabled_tools`/`disabled_tools`.
- **Token cost per server and per tool** in the client's own tokenizer family (Claude or GPT), including the server instructions Claude Code loads at session start.
- **Waste report:**
  - Heavy servers, bloated tools, duplicate entries and too many tools.
  - Servers you haven't called in 30 days, read from your local Claude Code history.
  - Tools Claude Code silently drops or truncates: names over 128 characters, invalid schema property names, descriptions past the 4,096-character cut.
  - Tool names GPT models reject.
- **Config hygiene:** hardcoded secrets in env, headers, args and URL query strings (masked in all output), unpinned `npx`/`uvx` packages, and commands missing from `PATH`.
- **Clear failure reasons:** "needs sign-in" for OAuth servers, timeouts, and crashes explained with the server's own stderr (e.g. `npm error 404`).
- **Profiles:** save a set of servers and apply it to a project's config, with backups and `restore`.
- **CI gate:** fail a pull request when the committed MCP config goes over a token budget, can't be measured, or contains a secret.
- **Private by default:** everything runs locally. Nothing is sent anywhere unless you pass `--exact`.

## Usage

```bash
npx mcp-scale                 # scan everything (asks before starting any server)
npx mcp-scale --static        # read configs only, never start servers
npx mcp-scale -c cursor vscode
npx mcp-scale -t claude       # count every client in Claude tokens (default: per client)
npx mcp-scale -f json         # or -f md for a shareable table
npx mcp-scale tools github    # one server's tools, heaviest first
```

### Profiles

```bash
npx mcp-scale profile create frontend --keep github,playwright
npx mcp-scale profile apply frontend --client cursor      # writes ./.cursor/mcp.json
npx mcp-scale profile apply frontend --client cursor --prune-user   # also drop others from ~/.cursor/mcp.json
npx mcp-scale restore                                     # undo the last apply
```

Profiles can target Claude Code (`.mcp.json`), Cursor, VS Code and Gemini CLI. Every write is backed up to `~/.mcp-scale/backups/` first, and other keys in the file are kept.

### CI

```yaml
- run: npx mcp-scale ci --max-tokens 15000
```

This checks the project-scoped configs committed to the repo (`.mcp.json`, `.vscode/mcp.json`, `.cursor/mcp.json`, `.gemini/settings.json`). It exits with code 1 when a client goes over budget, a server can't be measured (`--allow-unmeasured` relaxes this), or a secret is hardcoded. Committed `.mcp.json` servers count as approved, because that's what `claude -p` loads.

## How the numbers work

Each tool is serialized the way clients send it to the model (`{name, description, input_schema}`, with Claude Code's `mcp__server__tool` names and description cut-off) and counted offline with `o200k_base`.

- **GPT-family clients** (default for Cursor, VS Code, Windsurf, Codex, Gemini CLI): o200k is the GPT-4o/5 tokenizer, so the estimate is used as-is.
- **Claude clients** (Claude Code, Claude Desktop): the estimate is scaled by **1.67**, calibrated against Claude Code's own `/context` on 68 tools from 7 popular servers (mean error 5.4% per tool). Validated end to end:

  | Servers | Claude Code `/context` | mcp-scale |
  |---|---:|---:|
  | memory, sequential-thinking, everything | 6.2k | 6,206 |
  | filesystem, playwright, context7, deepwiki | 11.7k | 11,647 |

  mcp-scale also counts server instructions, which Claude Code loads at session start but `/context` files under a different category.
- **`--exact`** asks Anthropic's free `count_tokens` endpoint instead. This **sends tool definitions to Anthropic** and needs `ANTHROPIC_API_KEY`.
- **Tool Search:** with Claude Code's default Tool Search, deferred tools only cost their names, and the report shows both what loads at session start and the fully loaded size.

## Safety

Counting a server's tools means starting it, which runs the command in your config. mcp-scale lists those commands and asks before connecting. Use `--yes` to skip the prompt (CI) or `--static` to never start anything. Without a terminal it falls back to `--static`. Secret values are masked in every output format.

## Limitations

- **Claude Code plugin servers and claude.ai connectors aren't read.** Run `/context` in Claude Code for those.
- **OAuth-only remote servers are listed as "needs sign-in" and not counted.** mcp-scale can't reuse the client's sign-in.
- **Tools you switched off in an editor's UI** (e.g. Cursor's per-tool toggles, stored in its database) are still counted.
- **`ENABLE_TOOL_SEARCH=auto` thresholds assume a 200k context window.**

## Development

```bash
npm install
npm test          # vitest, includes a fake MCP server
npm run dev -- --static
npm run build
```

## License

MIT
