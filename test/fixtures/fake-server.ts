// Stdio MCP server for tests. Flags: --banner (junk on stdout first), --crash, --hang, --needs-roots.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makeServer } from "./mcp-server.js";

const flags = new Set(process.argv.slice(2));
if (flags.has("--crash")) {
  console.error("Error: FAKE_API_KEY is required");
  process.exit(2);
}
if (flags.has("--hang")) setInterval(() => {}, 1_000);
else {
  if (flags.has("--banner")) process.stdout.write("Starting fake server v9.9.9...\n");
  await makeServer({ needsRoots: flags.has("--needs-roots") }).connect(new StdioServerTransport());
}
