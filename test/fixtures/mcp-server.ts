// In-process MCP servers for tests: a stdio entry point (see fake-server.ts) and HTTP/SSE routes.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export const FAKE_TOOLS = [
  {
    name: "tool_0",
    description: "Fake tool number 0.",
    inputSchema: {
      type: "object" as const,
      properties: { q: { type: "string" } },
      required: ["q"],
    },
  },
  {
    name: "tool_1",
    description: `Fake tool number 1. ${"Long description. ".repeat(100)}`,
    inputSchema: { type: "object" as const, properties: { q: { type: "string" } } },
    _meta: { "anthropic/alwaysLoad": true },
  },
  {
    name: "tool_2",
    description: `Fake tool number 2. ${"Long description. ".repeat(300)}`,
    inputSchema: { type: "object" as const, properties: {} },
  },
];

export const FAKE_INSTRUCTIONS = "Use these tools for fake things.";

/** With `needsRoots`, adds a tool only for clients that declare the roots capability (like server-everything). */
export function makeServer(opts: { needsRoots?: boolean } = {}): Server {
  const server = new Server(
    { name: "fake", version: "9.9.9" },
    { capabilities: { tools: {} }, instructions: FAKE_INSTRUCTIONS },
  );
  // Two pages, to exercise pagination.
  server.setRequestHandler(ListToolsRequestSchema, async (req) => {
    if (opts.needsRoots) {
      const extra = server.getClientCapabilities()?.roots
        ? [{ name: "roots_tool", description: "r", inputSchema: { type: "object" as const } }]
        : [];
      return { tools: [...FAKE_TOOLS, ...extra] };
    }
    return req.params?.cursor
      ? { tools: FAKE_TOOLS.slice(2) }
      : { tools: FAKE_TOOLS.slice(0, 2), nextCursor: "p2" };
  });
  return server;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : undefined;
}

/**
 * Routes: /mcp (Streamable HTTP, stateless), /sse + /messages (legacy SSE only),
 * /auth (always 401), /bearer (Streamable HTTP requiring `Authorization: Bearer secret`).
 */
export async function startHttpServers(): Promise<{ base: string; close: () => Promise<void> }> {
  const sse = new Map<string, SSEServerTransport>();
  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (url.pathname === "/auth") {
        res.writeHead(401, { "www-authenticate": 'Bearer realm="test"' }).end("Unauthorized");
        return;
      }
      if (url.pathname === "/mcp" || url.pathname === "/bearer") {
        if (url.pathname === "/bearer" && req.headers.authorization !== "Bearer secret") {
          res.writeHead(401).end("missing or bad token");
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server = makeServer();
        res.on("close", () => {
          transport.close();
          server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, await readBody(req));
        return;
      }
      if (url.pathname === "/sse" && req.method === "GET") {
        const transport = new SSEServerTransport("/messages", res);
        sse.set(transport.sessionId, transport);
        res.on("close", () => sse.delete(transport.sessionId));
        await makeServer().connect(transport);
        return;
      }
      if (url.pathname === "/sse" && req.method === "POST") {
        res.writeHead(405).end("Method Not Allowed");
        return;
      }
      if (url.pathname === "/messages") {
        const transport = sse.get(url.searchParams.get("sessionId") ?? "");
        if (!transport) {
          res.writeHead(404).end();
          return;
        }
        await transport.handlePostMessage(req, res, await readBody(req));
        return;
      }
      res.writeHead(404).end();
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(String(e));
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
