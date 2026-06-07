/**
 * tool-registry — self-extending MCP server on Cloudflare Workers + KV
 *
 * Three meta-tools exposed to Claude Code:
 *   search_tool    — discover tools in registry by keyword
 *   use_tool       — execute any registered tool
 *   register_tool  — add a new tool so it's available next session
 *
 * MCP transport: Streamable HTTP (JSON-RPC 2.0 over POST /mcp)
 */

export interface Env {
  REGISTRY: KVNamespace;
  REGISTRY_TOKEN: string;
  MYAGENT_INVOKE_TOKEN: string;
  MYAGENT_URL: string;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDef {
  id: string;
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  invoke: InvokeConfig;
  tags?: string[];
  createdAt?: string;
}

interface IndexEntry {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

type InvokeConfig =
  | { type: "myagent_http"; tool: string; url?: string }
  | { type: "worker_url"; url: string };

// ── MCP meta-tool schemas ─────────────────────────────────────────────────────

const META_TOOLS = [
  {
    name: "search_tool",
    description:
      "Search the tool registry for available tools matching a query. " +
      "Returns tool IDs, names, and descriptions. " +
      "Call this first to discover what tools exist before using use_tool.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords describing what you need (e.g. 'search web', 'send email', 'scrape url', 'flights')",
        },
        limit: {
          type: "number",
          description: "Max results (default 10)",
          default: 10,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "use_tool",
    description:
      "Execute a registered tool by its ID with the given arguments. " +
      "Get the tool_id from search_tool first. " +
      "If the tool you need doesn't exist yet, build it and use register_tool.",
    inputSchema: {
      type: "object",
      properties: {
        tool_id: {
          type: "string",
          description: "Exact tool ID from search_tool results",
        },
        args: {
          type: "object",
          description: "Arguments to pass to the tool (tool-specific)",
          default: {},
        },
      },
      required: ["tool_id"],
    },
  },
  {
    name: "register_tool",
    description:
      "Register a new or updated tool in the registry. " +
      "Call this after building a new capability so it persists for future sessions. " +
      "For myagent tools use invoke.type='myagent_http'. " +
      "For new Cloudflare Worker endpoints use invoke.type='worker_url'.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Unique snake_case identifier (e.g. 'send_whatsapp', 'scrape_instagram')",
        },
        name: { type: "string", description: "Human-readable name" },
        description: {
          type: "string",
          description: "What the tool does — used for search matching",
        },
        parameters: {
          type: "object",
          description: "JSON Schema object describing accepted parameters",
        },
        invoke: {
          type: "object",
          description:
            "How to execute: " +
            "{ type: 'myagent_http', tool: 'tool_name_in_myagent' } or " +
            "{ type: 'worker_url', url: 'https://...' }",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Search tags (e.g. ['search', 'web', 'scraping'])",
        },
      },
      required: ["id", "name", "description", "invoke"],
    },
  },
];

// ── Entry point ───────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Auth — all endpoints require Bearer token
    const auth = request.headers.get("Authorization") ?? "";
    if (!env.REGISTRY_TOKEN || auth !== `Bearer ${env.REGISTRY_TOKEN}`) {
      return respond({ error: "Unauthorized" }, 401);
    }

    // Health check
    if (url.pathname === "/" && request.method === "GET") {
      const raw = await env.REGISTRY.get("index");
      const count = raw ? (JSON.parse(raw) as unknown[]).length : 0;
      return respond({ name: "tool-registry", version: "1.0.0", tools_registered: count });
    }

    // MCP endpoint
    if (url.pathname === "/mcp" && request.method === "POST") {
      const body = await request.json<JsonRpcRequest>();
      const result = await handleRpc(body, env);
      // Notifications (no id) get no response
      if (result === null) return new Response(null, { status: 204 });
      return respond(result);
    }

    return new Response("Not found", { status: 404 });
  },
};

// ── JSON-RPC router ───────────────────────────────────────────────────────────

async function handleRpc(req: JsonRpcRequest, env: Env): Promise<unknown> {
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: req.id ?? null, result });
  const err = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id: req.id ?? null,
    error: { code, message },
  });

  // Notifications have no id and need no response
  if (req.id === undefined || req.id === null) {
    return null;
  }

  switch (req.method) {
    case "initialize":
      return ok({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "tool-registry", version: "1.0.0" },
      });

    case "ping":
      return ok({});

    case "tools/list":
      return ok({ tools: META_TOOLS });

    case "tools/call": {
      const p = (req.params ?? {}) as { name: string; arguments: Record<string, unknown> };
      try {
        const result = await dispatchTool(p.name, p.arguments ?? {}, env);
        return ok({
          content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
        });
      } catch (e) {
        return ok({
          content: [{ type: "text", text: `Error: ${String(e)}` }],
          isError: true,
        });
      }
    }

    default:
      return err(-32601, `Method not found: ${req.method}`);
  }
}

async function dispatchTool(name: string, args: Record<string, unknown>, env: Env): Promise<unknown> {
  switch (name) {
    case "search_tool":
      return searchTools(String(args.query ?? ""), Number(args.limit ?? 10), env);
    case "use_tool":
      return useTool(String(args.tool_id ?? ""), (args.args ?? {}) as Record<string, unknown>, env);
    case "register_tool":
      return registerTool(args, env);
    default:
      throw new Error(`Unknown meta-tool: ${name}`);
  }
}

// ── search_tool ───────────────────────────────────────────────────────────────

async function searchTools(query: string, limit: number, env: Env): Promise<string> {
  const raw = await env.REGISTRY.get("index");
  if (!raw) {
    return "Registry is empty. Use register_tool to add tools, or run the seed script.";
  }

  const index = JSON.parse(raw) as IndexEntry[];
  const q = query.toLowerCase();

  const scored = index
    .map((t) => {
      const text = `${t.name} ${t.description} ${(t.tags ?? []).join(" ")}`.toLowerCase();
      // Exact ID match scores highest; description match scores 1; tag match scores 0.5
      const score =
        (t.id === query ? 10 : 0) +
        (t.name.toLowerCase().includes(q) ? 3 : 0) +
        (t.description.toLowerCase().includes(q) ? 1 : 0) +
        ((t.tags ?? []).some((tag) => tag.toLowerCase().includes(q)) ? 0.5 : 0) +
        (text.includes(q) ? 0.1 : 0);
      return { t, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.t);

  if (!scored.length) {
    return (
      `No tools found matching "${query}".\n` +
      `Try broader terms, or use register_tool to add what you need.\n` +
      `Total registered: ${index.length}`
    );
  }

  const lines = scored.map((t) => `**${t.id}** — ${t.description}`);
  return lines.join("\n");
}

// ── use_tool ──────────────────────────────────────────────────────────────────

async function useTool(toolId: string, args: Record<string, unknown>, env: Env): Promise<string> {
  const raw = await env.REGISTRY.get(`tool:${toolId}`);
  if (!raw) {
    return (
      `Tool "${toolId}" not found in registry.\n` +
      `Use search_tool to find available tools, or register_tool to add it.`
    );
  }

  const tool = JSON.parse(raw) as ToolDef;
  const invoke = tool.invoke;

  if (invoke.type === "myagent_http") {
    const url = invoke.url ?? `${env.MYAGENT_URL}/api/invoke`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.MYAGENT_INVOKE_TOKEN}`,
      },
      body: JSON.stringify({ tool: invoke.tool, args }),
    });
    if (!res.ok) {
      throw new Error(`myagent returned HTTP ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { result?: string; error?: string };
    if (data.error) throw new Error(data.error);
    return data.result ?? "";
  }

  if (invoke.type === "worker_url") {
    const res = await fetch(invoke.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`Worker returned HTTP ${res.status}`);
    return await res.text();
  }

  throw new Error(`Unknown invoke type: ${(invoke as { type: string }).type}`);
}

// ── register_tool ─────────────────────────────────────────────────────────────

async function registerTool(def: Record<string, unknown>, env: Env): Promise<string> {
  const id = String(def.id ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

  if (!id) throw new Error("id is required and must contain alphanumeric characters");
  if (!def.invoke) throw new Error("invoke is required");

  const tool: ToolDef = {
    id,
    name: String(def.name ?? id),
    description: String(def.description ?? ""),
    parameters: (def.parameters as Record<string, unknown>) ?? {},
    invoke: def.invoke as InvokeConfig,
    tags: (def.tags as string[]) ?? [],
    createdAt: new Date().toISOString(),
  };

  await env.REGISTRY.put(`tool:${id}`, JSON.stringify(tool));

  // Update index
  const rawIndex = await env.REGISTRY.get("index");
  const index: IndexEntry[] = rawIndex ? (JSON.parse(rawIndex) as IndexEntry[]) : [];
  const existing = index.findIndex((t) => t.id === id);
  const entry: IndexEntry = { id, name: tool.name, description: tool.description, tags: tool.tags ?? [] };

  if (existing >= 0) {
    index[existing] = entry;
  } else {
    index.push(entry);
  }

  await env.REGISTRY.put("index", JSON.stringify(index));

  return `Tool "${id}" registered. Discoverable via search_tool immediately. Total registered: ${index.length}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function respond(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
