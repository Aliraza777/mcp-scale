import { defineConfig } from "vitest/config";

export default defineConfig({
  // CI runners are slower than dev machines and several tests spawn MCP servers.
  test: { testTimeout: 20_000 },
});
